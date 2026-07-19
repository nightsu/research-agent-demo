import { describe, expect, it, vi } from "vitest";

import {
  MAX_ENCODED_EVENT_BYTES,
  type ResearchEvent,
} from "./research-events";
import {
  consumeResearchStream,
  createResearchStreamWriterGate,
  ResearchStreamProtocolError,
  type TransientDraft,
} from "./research-stream-protocol";

const encoder = new TextEncoder();

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function streamFromByteChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("consumeResearchStream", () => {
  it("consumes a clean plan stream through arbitrary NDJSON chunks", async () => {
    const durableEvents: ResearchEvent[] = [];
    const drafts: TransientDraft[] = [];
    const payload = [
      JSON.stringify({
        type: "plan.completed",
        plan: {
          objective: "Compare rendering changes",
          subquestions: ["What changed?"],
          searchQueries: ["browser rendering changes"],
        },
      }),
      JSON.stringify({ type: "plan.awaiting_approval" }),
      "",
    ].join("\n");

    const result = await consumeResearchStream(
      streamFromChunks([payload.slice(0, 17), payload.slice(17)]),
      {
        request: "plan",
        onDurableEvent: vi.fn((event) => {
          durableEvents.push(event);
        }),
        onTransientDraft: vi.fn((draft) => {
          drafts.push(draft);
        }),
      },
    );

    expect(durableEvents.map((event) => event.type)).toEqual([
      "plan.completed",
      "plan.awaiting_approval",
    ]);
    expect(drafts).toEqual([]);
    expect(result).toEqual({
      requestTerminal: { type: "plan.awaiting_approval" },
      retainedViolations: [],
    });
  });

  it("withholds Plan Review authorization until the stream reaches clean EOF", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const durableEvents: ResearchEvent[] = [];
    const pending = consumeResearchStream(source, {
      request: "plan",
      onDurableEvent(event) {
        durableEvents.push(event);
      },
    });

    streamController.enqueue(
      encoder.encode(`${JSON.stringify({ type: "plan.awaiting_approval" })}\n`),
    );
    await Promise.resolve();
    expect(durableEvents).toEqual([]);

    streamController.close();
    await pending;
    expect(durableEvents).toEqual([{ type: "plan.awaiting_approval" }]);
  });

  it("projects contiguous report deltas into Transient draft snapshots", async () => {
    const durableEvents: ResearchEvent[] = [];
    const drafts: TransientDraft[] = [];
    const payload = [
      JSON.stringify({ type: "report.started", partial: false }),
      JSON.stringify({
        type: "report.delta",
        sequence: 0,
        mode: "append",
        text: "# Draft",
      }),
      JSON.stringify({
        type: "report.delta",
        sequence: 1,
        mode: "append",
        text: " grows",
      }),
      JSON.stringify({ type: "research.failed", message: "Stopped.", recoverable: true }),
      "",
    ].join("\n");

    const result = await consumeResearchStream(streamFromChunks([payload]), {
      request: "execute",
      onDurableEvent(event) {
        durableEvents.push(event);
      },
      onTransientDraft(draft) {
        drafts.push(draft);
      },
    });

    expect(durableEvents.map((event) => event.type)).toEqual([
      "report.started",
      "research.failed",
    ]);
    expect(drafts).toEqual([
      { markdown: "# Draft", sequence: 0 },
      { markdown: "# Draft grows", sequence: 1 },
    ]);
    expect(result.transientDraft).toEqual(drafts.at(-1));
  });

  it.each([
    ["duplicate", [0, 0]],
    ["gap", [0, 2]],
    ["out of order", [1]],
  ] as const)("rejects a %s report delta sequence", async (_label, sequences) => {
    const payload = [
      JSON.stringify({ type: "report.started", partial: false }),
      ...sequences.map((sequence) =>
        JSON.stringify({
          type: "report.delta",
          sequence,
          mode: "append",
          text: "draft",
        }),
      ),
      JSON.stringify({ type: "research.failed", message: "Stopped.", recoverable: true }),
      "",
    ].join("\n");

    await expect(
      consumeResearchStream(streamFromChunks([payload]), { request: "execute" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "INVALID_DELTA_SEQUENCE",
      }),
    );
  });

  it("retains the first Research Terminal when a later record violates the protocol", async () => {
    const terminal = {
      type: "research.failed" as const,
      message: "The provider stopped.",
      recoverable: true,
    };
    const payload = [
      JSON.stringify(terminal),
      JSON.stringify({ type: "plan.started", question: "A valid research question?" }),
      "",
    ].join("\n");

    const result = await consumeResearchStream(streamFromChunks([payload]), {
      request: "execute",
    });

    expect(result.researchTerminal).toEqual(terminal);
    expect(result.retainedViolations).toEqual([
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "EVENT_AFTER_TERMINAL",
      }),
    ]);
  });

  it("forms an immediate Research Terminal when the client cancels locally", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      cancel: cancelled,
    });
    const controller = new AbortController();
    const durableEvents: ResearchEvent[] = [];

    const pending = consumeResearchStream(source, {
      request: "execute",
      cancellationSignal: controller.signal,
      onDurableEvent(event) {
        durableEvents.push(event);
      },
    });
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(pending).resolves.toMatchObject({
      requestTerminal: { type: "research.cancelled" },
      researchTerminal: { type: "research.cancelled" },
    });
    expect(durableEvents.at(-1)).toEqual({ type: "research.cancelled" });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("honors a local cancellation that happened before consumption began", async () => {
    const cancelled = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));

    await expect(
      consumeResearchStream(source, {
        request: "plan",
        cancellationSignal: controller.signal,
      }),
    ).resolves.toMatchObject({
      researchTerminal: { type: "research.cancelled" },
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("does not replace an accepted Research Terminal with a later local cancellation", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const cancellation = new AbortController();
    const terminal = {
      type: "research.failed" as const,
      message: "The provider stopped.",
      recoverable: true,
    };
    const durableEvents: ResearchEvent[] = [];
    const pending = consumeResearchStream(source, {
      request: "execute",
      cancellationSignal: cancellation.signal,
      onDurableEvent(event) {
        durableEvents.push(event);
      },
    });

    streamController.enqueue(encoder.encode(`${JSON.stringify(terminal)}\n`));
    await vi.waitFor(() => expect(durableEvents).toEqual([terminal]));
    cancellation.abort(new DOMException("Too late", "AbortError"));

    await expect(pending).resolves.toMatchObject({
      requestTerminal: terminal,
      researchTerminal: terminal,
    });
    expect(durableEvents).toEqual([terminal]);
  });

  it("rejects an incoming NDJSON record above the encoded event limit", async () => {
    const oversized = `${JSON.stringify({
      type: "report.delta",
      sequence: 0,
      mode: "append",
      text: "x".repeat(MAX_ENCODED_EVENT_BYTES),
    })}\n`;

    await expect(
      consumeResearchStream(streamFromChunks([oversized]), {
        request: "execute",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "EVENT_TOO_LARGE",
      }),
    );
  });

  it("rejects an execution-only terminal in a plan request", async () => {
    const onDurableEvent = vi.fn();
    const payload = `${JSON.stringify({
      type: "report.completed",
      report: {
        title: "Unexpected report",
        executiveSummary: "A plan request cannot finish research.",
        findings: [],
        trends: [],
        disagreements: [],
        limitations: [],
      },
    })}\n`;

    await expect(
      consumeResearchStream(streamFromChunks([payload]), {
        request: "plan",
        onDurableEvent,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "UNEXPECTED_TERMINAL",
      }),
    );
    expect(onDurableEvent).not.toHaveBeenCalled();
  });

  it("rejects execution events in a plan request before they can authorize research", async () => {
    const onDurableEvent = vi.fn();
    const payload = `${JSON.stringify({
      type: "search.started",
      query: "agent protocol",
      reason: "This must require an Approved Plan.",
    })}\n`;

    await expect(
      consumeResearchStream(streamFromChunks([payload]), {
        request: "plan",
        onDurableEvent,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "UNEXPECTED_EVENT",
      }),
    );
    expect(onDurableEvent).not.toHaveBeenCalled();
  });

  it("fails a provisional Plan Review closed when a trailing record arrives", async () => {
    const onDurableEvent = vi.fn();
    const payload = [
      JSON.stringify({ type: "plan.awaiting_approval" }),
      JSON.stringify({ type: "plan.started", question: "Unexpected tail" }),
      "",
    ].join("\n");

    await expect(
      consumeResearchStream(streamFromChunks([payload]), {
        request: "plan",
        onDurableEvent,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "EVENT_AFTER_TERMINAL",
      }),
    );
    expect(onDurableEvent).not.toHaveBeenCalledWith({
      type: "plan.awaiting_approval",
    });
  });

  it("rejects invalid UTF-8 split across transport chunks", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xe2]));
        controller.enqueue(new Uint8Array([0x28, 0xa1]));
        controller.close();
      },
    });

    await expect(
      consumeResearchStream(source, { request: "execute" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "INVALID_UTF8",
      }),
    );
  });

  it("decodes a valid multibyte UTF-8 value split inside one code point", async () => {
    const terminal = {
      type: "research.failed" as const,
      message: "研究已安全停止。",
      recoverable: true,
    };
    const bytes = encoder.encode(`${JSON.stringify(terminal)}\n`);
    const splitAt = encoder.encode(`${JSON.stringify(terminal)}`.split("研")[0]).byteLength + 1;

    await expect(
      consumeResearchStream(
        streamFromByteChunks([bytes.slice(0, splitAt), bytes.slice(splitAt)]),
        { request: "execute" },
      ),
    ).resolves.toMatchObject({ researchTerminal: terminal });
  });

  it.each([
    [
      "a report delta before report.started",
      [
        { type: "report.delta", sequence: 0, mode: "append", text: "draft" },
      ],
      "DELTA_WITHOUT_REPORT",
    ],
    [
      "a duplicate report.started",
      [
        { type: "report.started", partial: false },
        { type: "report.started", partial: false },
      ],
      "DUPLICATE_REPORT_START",
    ],
  ] as const)("rejects %s", async (_label, events, code) => {
    const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

    await expect(
      consumeResearchStream(streamFromChunks([payload]), { request: "execute" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({ code }),
    );
  });

  it("retains a transport failure after the first Research Terminal", async () => {
    const terminal = {
      type: "research.failed" as const,
      message: "The provider stopped.",
      recoverable: true,
    };
    let delivered = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(encoder.encode(`${JSON.stringify(terminal)}\n`));
          return;
        }
        controller.error(new Error("transport failed"));
      },
    });

    const result = await consumeResearchStream(source, { request: "execute" });

    expect(result.researchTerminal).toEqual(terminal);
    expect(result.retainedViolations).toEqual([
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "TRANSPORT_AFTER_TERMINAL",
      }),
    ]);
  });

  it.each([
    ["missing terminal", `${JSON.stringify({ type: "report.started", partial: false })}\n`, "MISSING_REQUEST_TERMINAL"],
    ["trailing bytes", JSON.stringify({ type: "research.cancelled" }), "TRAILING_BYTES"],
  ] as const)("rejects a stream with %s", async (_label, payload, code) => {
    await expect(
      consumeResearchStream(streamFromChunks([payload]), { request: "execute" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({ code }),
    );
  });

  it("awaits callbacks in wire order and propagates adapter failures", async () => {
    const order: string[] = [];
    const payload = [
      JSON.stringify({ type: "report.started", partial: false }),
      JSON.stringify({ type: "research.cancelled" }),
      "",
    ].join("\n");

    await expect(
      consumeResearchStream(streamFromChunks([payload]), {
        request: "execute",
        async onDurableEvent(event) {
          order.push(`start:${event.type}`);
          await Promise.resolve();
          order.push(`end:${event.type}`);
          if (event.type === "research.cancelled") throw new Error("adapter failed");
        },
      }),
    ).rejects.toThrow("adapter failed");
    expect(order).toEqual([
      "start:report.started",
      "end:report.started",
      "start:research.cancelled",
      "end:research.cancelled",
    ]);
  });
});

describe("createResearchStreamWriterGate", () => {
  it("commits a Request Terminal only after its encoded record is delivered", async () => {
    const delivered: string[] = [];
    const delivery = vi.fn(async (encoded: Uint8Array) => {
      delivered.push(new TextDecoder().decode(encoded));
    });
    const fallbackEvent = {
      type: "research.failed" as const,
      message: "The research request failed.",
      recoverable: false,
    };
    const writer = createResearchStreamWriterGate("plan");

    await writer.deliver({ type: "plan.awaiting_approval" }, delivery);
    const terminal = await writer.finish({ fallbackEvent, deliver: delivery });

    expect(delivered).toEqual([
      `${JSON.stringify({ type: "plan.awaiting_approval" })}\n`,
    ]);
    expect(terminal).toEqual({ type: "plan.awaiting_approval" });
    expect(delivery).toHaveBeenCalledOnce();
  });

  it("uses the fallback when a previous terminal delivery did not succeed", async () => {
    const failedDelivery = vi.fn(async () => {
      throw new Error("stream closed");
    });
    const fallbackDelivery = vi.fn(async () => {});
    const fallbackEvent = {
      type: "research.failed" as const,
      message: "The research request failed.",
      recoverable: false,
    };
    const writer = createResearchStreamWriterGate("plan");

    await expect(
      writer.deliver({ type: "plan.awaiting_approval" }, failedDelivery),
    ).rejects.toThrow("stream closed");
    await expect(
      writer.finish({ fallbackEvent, deliver: fallbackDelivery }),
    ).resolves.toEqual(fallbackEvent);

    expect(fallbackDelivery).toHaveBeenCalledOnce();
  });

  it("shares one transactional fallback across concurrent finish calls", async () => {
    const writer = createResearchStreamWriterGate("execute");
    const delivery = vi.fn(async () => {
      await Promise.resolve();
    });
    const fallbackEvent = {
      type: "research.failed" as const,
      message: "The research request failed.",
      recoverable: false,
    };

    const [first, second] = await Promise.all([
      writer.finish({ fallbackEvent, deliver: delivery }),
      writer.finish({ fallbackEvent, deliver: delivery }),
    ]);

    expect(first).toEqual(fallbackEvent);
    expect(second).toEqual(fallbackEvent);
    expect(delivery).toHaveBeenCalledOnce();
  });

  it("rejects plan-phase events from an execution writer", async () => {
    const writer = createResearchStreamWriterGate("execute");

    await expect(
      writer.deliver(
        { type: "plan.started", question: "Wrong phase" },
        vi.fn(),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ResearchStreamProtocolError>>({
        code: "UNEXPECTED_EVENT",
      }),
    );
  });
});
