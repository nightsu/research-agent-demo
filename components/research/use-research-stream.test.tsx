import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type {
  ResearchInput,
  ResearchRequest,
} from "@/lib/agent/research-types";

import { useResearchStream } from "./use-research-stream";

const input: ResearchInput = {
  question: "What changed in browser rendering this year?",
  timeRange: "year",
  depth: "quick",
};
const proposedPlan = {
  objective: "Understand browser rendering changes",
  subquestions: ["What changed?"],
  searchQueries: ["browser rendering changes"],
};

const report = {
  title: "Browser rendering",
  executiveSummary: "Rendering changed.",
  findings: [
    {
      claim: "A rendering change shipped.",
      sourceIds: ["source-1"],
      confidence: "high" as const,
    },
  ],
  trends: [],
  disagreements: [],
  limitations: [],
};

function line(event: ResearchEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function localFailure(
  message: string,
  recoverable = true,
): ResearchEvent {
  return { type: "research.failed", message, recoverable };
}

function planReviewResponse(): Response {
  return responseFromChunks([
    line({ type: "plan.completed", plan: proposedPlan }),
    line({ type: "plan.awaiting_approval" }),
  ]);
}

function responseFromChunks(
  chunks: string[],
  options: { onCancel?: () => void; failAfter?: number } = {},
): Response {
  const encoder = new TextEncoder();
  let index = 0;

  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (options.failAfter === index) {
          controller.error(new Error("reader secret"));
          return;
        }
        if (index === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index++]));
      },
      cancel: options.onCancel,
    }),
    { status: 200 },
  );

  if (!options.onCancel) return response;
  const reader = response.body!.getReader();
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: () => reader.read(),
          cancel: async () => {
            options.onCancel?.();
            await reader.cancel();
          },
          releaseLock: () => reader.releaseLock(),
        };
      },
    },
  } as Response;
}

function responseFromByteChunks(
  chunks: Uint8Array[],
  onReaderCancel?: () => void,
): Response {
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
    }),
  );

  if (!onReaderCancel) return response;
  const reader = response.body!.getReader();
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: () => reader.read(),
          cancel: async () => {
            onReaderCancel();
            await reader.cancel();
          },
          releaseLock: () => reader.releaseLock(),
        };
      },
    },
  } as Response;
}

function deferredResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel: cancelled,
    }),
  );

  return {
    response,
    enqueue(value: string) {
      controller.enqueue(encoder.encode(value));
    },
    close() {
      controller.close();
    },
    error(error: Error) {
      controller.error(error);
    },
    cancelled,
  };
}

function responseWithReaderSpies(chunks: string[]) {
  const response = responseFromChunks(chunks);
  const reader = response.body!.getReader();
  const cancel = vi.fn(() => reader.cancel());
  const releaseLock = vi.fn(() => reader.releaseLock());

  return {
    response: {
      ok: true,
      body: {
        getReader: () => ({
          read: () => reader.read(),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Response,
    cancel,
    releaseLock,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function drainStreamReads(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("useResearchStream", () => {
  it("requests a plan and exposes it for review before research begins", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responseFromChunks([
        line({ type: "plan.started", question: input.question }),
        line({ type: "plan.completed", plan: proposedPlan }),
        line({ type: "plan.awaiting_approval" }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/research",
      expect.objectContaining({
        body: JSON.stringify({ action: "plan", input }),
      }),
    );
    expect(result.current.run.status).toBe("awaiting-review");
    expect(result.current.planReview).toEqual({ input, plan: proposedPlan });
  });

  it("submits a revised Approved Plan without replacing the original input", async () => {
    const revisedPlan = {
      ...proposedPlan,
      objective: "Compare browser rendering changes",
      searchQueries: ["browser rendering comparison"],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        responseFromChunks([
          line({ type: "plan.completed", plan: proposedPlan }),
          line({ type: "plan.awaiting_approval" }),
        ]),
      )
      .mockResolvedValueOnce(
        responseFromChunks([line({ type: "report.completed", report })]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(revisedPlan));

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      action: "execute",
      input,
      plan: revisedPlan,
    });
    expect(result.current.run.status).toBe("completed");
    expect(result.current.run.events.map((event) => event.type)).toEqual([
      "plan.completed",
      "plan.awaiting_approval",
      "report.completed",
    ]);
  });

  it("retries failed execution with the same Approved Plan", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        responseFromChunks([
          line({ type: "plan.completed", plan: proposedPlan }),
          line({ type: "plan.awaiting_approval" }),
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        responseFromChunks([line({ type: "report.completed", report })]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));
    expect(result.current.run.status).toBe("failed");
    await act(() => result.current.retry());

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      action: "execute",
      input,
      plan: proposedPlan,
    });
    expect(result.current.run.status).toBe("completed");
    expect(result.current.run.events.map((event) => event.type)).toEqual([
      "plan.completed",
      "plan.awaiting_approval",
      "report.completed",
    ]);
  });

  it("retries cancelled execution with the same Approved Plan", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        responseFromChunks([
          line({ type: "plan.completed", plan: proposedPlan }),
          line({ type: "plan.awaiting_approval" }),
        ]),
      )
      .mockImplementationOnce((_url, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      )
      .mockResolvedValueOnce(
        responseFromChunks([line({ type: "report.completed", report })]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    let execution!: Promise<void>;
    act(() => {
      execution = result.current.approvePlan(proposedPlan);
    });
    await waitFor(() => expect(result.current.run.status).toBe("running"));
    act(() => result.current.cancel());
    await act(() => execution);
    expect(result.current.run.status).toBe("cancelled");

    await act(() => result.current.retry());

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      action: "execute",
      input,
      plan: proposedPlan,
    });
    expect(result.current.run.status).toBe("completed");
  });

  it("buffers report deltas outside the durable event log and flushes one batched draft after 40ms", async () => {
    vi.useFakeTimers();
    const stream = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(stream.response),
    );
    const { result } = renderHook(() => useResearchStream());
    await act(() => result.current.start(input));
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.approvePlan(proposedPlan);
    });

    act(() => {
      stream.enqueue(line({ type: "report.started", partial: false }));
      stream.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "# Draft" }));
      stream.enqueue(line({ type: "report.delta", sequence: 1, mode: "append", text: " grows" }));
    });
    await drainStreamReads();

    expect(result.current.run.reportDraft).toEqual({
      markdown: "",
      sequence: -1,
      status: "streaming",
    });
    expect(result.current.run.events.map((event) => event.type)).toEqual([
      "plan.completed",
      "plan.awaiting_approval",
      "report.started",
    ]);
    act(() => vi.advanceTimersByTime(39));
    expect(result.current.run.reportDraft?.markdown).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.run.reportDraft).toEqual({
      markdown: "# Draft grows",
      sequence: 1,
      status: "streaming",
    });

    act(() => stream.enqueue(line({ type: "research.cancelled" })));
    act(() => stream.close());
    await act(() => promise);
  });

  it("uses replace deltas as complete snapshots", async () => {
    vi.useFakeTimers();
    const stream = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(stream.response),
    );
    const { result } = renderHook(() => useResearchStream());
    await act(() => result.current.start(input));
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.approvePlan(proposedPlan);
    });
    act(() => {
      stream.enqueue(line({ type: "report.started", partial: false }));
      stream.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "old" }));
      stream.enqueue(line({ type: "report.delta", sequence: 1, mode: "replace", text: "new snapshot" }));
    });
    await drainStreamReads();
    act(() => vi.advanceTimersByTime(40));

    expect(result.current.run.reportDraft?.markdown).toBe("new snapshot");
    expect(result.current.run.reportDraft?.sequence).toBe(1);
    act(() => stream.enqueue(line({ type: "research.cancelled" })));
    act(() => stream.close());
    await act(() => promise);
  });

  it.each([
    ["duplicate", [0, 0]],
    ["gap", [0, 2]],
    ["out of order", [1]],
  ] as const)("fails safely on a %s delta sequence while preserving the last legal draft", async (_name, sequences) => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const chunks = [
      line({ type: "report.started", partial: false }),
      ...sequences.map((sequence, index) =>
        line({
          type: "report.delta",
          sequence,
          mode: "append",
          text: index === 0 && sequence === 0 ? "safe draft" : "provider-secret-raw-delta",
        }),
      ),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(responseFromChunks(chunks, { onCancel: cancelled })),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));

    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.error).toBe("Research stream protocol error.");
    expect(result.current.run.reportDraft).toEqual({
      markdown: sequences[0] === 0 ? "safe draft" : "",
      sequence: sequences[0] === 0 ? 0 : -1,
      status: "incomplete",
    });
    expect(result.current.run.events.map((event) => event.type)).toEqual([
      "plan.completed",
      "plan.awaiting_approval",
      "report.started",
      "research.failed",
    ]);
    expect(JSON.stringify(result.current.run)).not.toContain("provider-secret-raw-delta");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate report start without resetting the active accumulator", async () => {
    vi.useFakeTimers();
    const stream = responseWithReaderSpies([
      line({ type: "report.started", partial: false }),
      line({ type: "report.delta", sequence: 0, mode: "append", text: "# First" }),
      line({ type: "report.started", partial: false }),
      line({ type: "report.delta", sequence: 0, mode: "replace", text: "# Reset provider secret" }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(stream.response),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));

    expect(result.current.run).toEqual({
      status: "failed",
      events: [
        { type: "plan.completed", plan: proposedPlan },
        { type: "plan.awaiting_approval" },
        { type: "report.started", partial: false },
        localFailure("Research stream protocol error."),
      ],
      reportDraft: {
        markdown: "# First",
        sequence: 0,
        status: "incomplete",
      },
      hadReportDraft: true,
      error: "Research stream protocol error.",
    });
    expect(JSON.stringify(result.current.run)).not.toContain(
      "# Reset provider secret",
    );
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("force-flushes before validating, repairing, and a terminal event", async () => {
    vi.useFakeTimers();
    const stream = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(stream.response),
    );
    const { result } = renderHook(() => useResearchStream());
    await act(() => result.current.start(input));
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.approvePlan(proposedPlan);
    });
    act(() => {
      stream.enqueue(line({ type: "report.started", partial: false }));
      stream.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "draft" }));
      stream.enqueue(line({ type: "report.validating" }));
    });
    await drainStreamReads();
    expect(result.current.run.reportDraft).toEqual({
      markdown: "draft",
      sequence: 0,
      status: "validating",
    });
    expect(result.current.run.events.map((event) => event.type).slice(-2)).toEqual([
      "report.started",
      "report.validating",
    ]);

    act(() => stream.enqueue(line({ type: "report.repairing" })));
    await drainStreamReads();
    expect(result.current.run.reportDraft?.status).toBe("repairing");
    expect(result.current.run.events.at(-1)?.type).toBe("report.repairing");
    act(() => stream.enqueue(line({ type: "report.completed", report })));
    act(() => stream.close());
    await act(() => promise);

    expect(result.current.run.reportDraft).toBeUndefined();
    expect(result.current.run.hadReportDraft).toBe(true);
    expect(result.current.run.status).toBe("completed");
  });

  it.each([
    ["report.completed", "completed"],
    ["research.partial", "partial"],
  ] as const)("clears a flushed draft on %s and remembers that streaming content existed", async (type, status) => {
    vi.useFakeTimers();
    const terminal: ResearchEvent =
      type === "report.completed"
        ? { type, report }
        : { type, report, reason: "Source limit reached." };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(responseFromChunks([
          line({ type: "report.started", partial: type === "research.partial" }),
          line({ type: "report.delta", sequence: 0, mode: "append", text: "draft" }),
          line(terminal),
        ])),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));

    expect(result.current.run.status).toBe(status);
    expect(result.current.run.reportDraft).toBeUndefined();
    expect(result.current.run.hadReportDraft).toBe(true);
  });

  it.each([
    ["research.failed", "failed"],
    ["research.cancelled", "cancelled"],
  ] as const)("force-flushes and preserves an incomplete draft on %s", async (type, status) => {
    vi.useFakeTimers();
    const terminal: ResearchEvent =
      type === "research.failed"
        ? { type, message: "Safe server error.", recoverable: true }
        : { type };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(
          responseFromChunks([
            line({ type: "report.started", partial: false }),
            line({ type: "report.delta", sequence: 0, mode: "append", text: "unfinished" }),
            line(terminal),
          ]),
        ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));

    expect(result.current.run.status).toBe(status);
    expect(result.current.run.reportDraft).toEqual({
      markdown: "unfinished",
      sequence: 0,
      status: "incomplete",
    });
    expect(result.current.run.hadReportDraft).toBe(true);
  });

  it("starts with an empty streaming draft but does not claim content on a delta-free completion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(responseFromChunks([
          line({ type: "report.started", partial: false }),
          line({ type: "report.completed", report }),
        ])),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));

    expect(result.current.run.reportDraft).toBeUndefined();
    expect(result.current.run.hadReportDraft).toBe(false);
  });

  it("clears buffered draft ownership on reset and a new generation", async () => {
    vi.useFakeTimers();
    const first = deferredResponse();
    const second = deferredResponse();
    const afterReset = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(second.response)
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(afterReset.response),
    );
    const { result } = renderHook(() => useResearchStream());
    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    await act(() => result.current.start(input));
    act(() => {
      firstPromise = result.current.approvePlan(proposedPlan);
    });
    act(() => {
      first.enqueue(line({ type: "report.started", partial: false }));
      first.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "stale" }));
    });
    await drainStreamReads();

    await act(() =>
      result.current.start({
        ...input,
        question: "What changed in JavaScript engines this year?",
      }),
    );
    await act(() => firstPromise);
    act(() => {
      secondPromise = result.current.approvePlan(proposedPlan);
    });
    expect(result.current.run.reportDraft).toBeUndefined();
    expect(result.current.run.hadReportDraft).toBe(false);
    act(() => vi.advanceTimersByTime(40));
    expect(result.current.run.reportDraft).toBeUndefined();

    act(() => {
      second.enqueue(line({ type: "report.started", partial: false }));
      second.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "fresh second run" }));
      second.enqueue(line({ type: "research.cancelled" }));
    });
    act(() => second.close());
    await act(() => secondPromise);
    expect(result.current.run.reportDraft?.markdown).toBe("fresh second run");
    expect(result.current.run.reportDraft?.sequence).toBe(0);
    act(() => result.current.reset());
    expect(result.current.run).toMatchObject({
      status: "idle",
      events: [],
      hadReportDraft: false,
    });

    await act(() => result.current.start(input));
    let afterResetPromise!: Promise<void>;
    act(() => {
      afterResetPromise = result.current.approvePlan(proposedPlan);
    });
    act(() => {
      afterReset.enqueue(line({ type: "report.started", partial: false }));
      afterReset.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "fresh after reset" }));
      afterReset.enqueue(line({ type: "research.cancelled" }));
      afterReset.close();
    });
    await act(() => afterResetPromise);
    expect(result.current.run.reportDraft?.markdown).toBe("fresh after reset");
    expect(result.current.run.reportDraft?.sequence).toBe(0);
  });

  it("retries with a fresh accumulator and ignores the previous generation's pending flush", async () => {
    vi.useFakeTimers();
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(second.response),
    );
    const { result } = renderHook(() => useResearchStream());
    let firstPromise!: Promise<void>;
    let retryPromise!: Promise<void>;
    await act(() => result.current.start(input));
    act(() => {
      firstPromise = result.current.approvePlan(proposedPlan);
    });
    act(() => {
      first.enqueue(line({ type: "report.started", partial: false }));
      first.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "stale retry draft" }));
    });
    await drainStreamReads();

    act(() => {
      retryPromise = result.current.retry();
    });
    expect(result.current.run.reportDraft).toBeUndefined();
    expect(result.current.run.hadReportDraft).toBe(false);
    act(() => vi.advanceTimersByTime(40));
    expect(result.current.run.reportDraft).toBeUndefined();

    act(() => {
      second.enqueue(line({ type: "report.started", partial: false }));
      second.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "fresh retry draft" }));
      second.enqueue(line({ type: "research.cancelled" }));
    });
    act(() => second.close());
    await act(() => retryPromise);
    await act(() => firstPromise);
    expect(result.current.run.reportDraft?.markdown).toBe("fresh retry draft");
    expect(result.current.run.reportDraft?.sequence).toBe(0);
    expect(result.current.run.events.map((event) => event.type)).toEqual([
      "plan.completed",
      "plan.awaiting_approval",
      "report.started",
      "research.cancelled",
    ]);
  });

  it("cancels with an immediate incomplete flush and clears pending timers on unmount in Strict Mode", async () => {
    vi.useFakeTimers();
    const stream = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(stream.response),
    );
    const { result, unmount } = renderHook(() => useResearchStream(), {
      wrapper: StrictMode,
    });
    await act(() => result.current.start(input));
    act(() => {
      void result.current.approvePlan(proposedPlan);
    });
    act(() => {
      stream.enqueue(line({ type: "report.started", partial: false }));
      stream.enqueue(line({ type: "report.delta", sequence: 0, mode: "append", text: "cancelled draft" }));
    });
    await drainStreamReads();

    act(() => result.current.cancel());
    expect(result.current.run.reportDraft).toEqual({
      markdown: "cancelled draft",
      sequence: 0,
      status: "incomplete",
    });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reassembles split JSON, multiple records, and CRLF in event order", async () => {
    const first: ResearchEvent = {
      type: "plan.started",
      question: input.question,
    };
    const second: ResearchEvent = {
      type: "plan.completed",
      plan: proposedPlan,
    };
    const terminal: ResearchEvent = { type: "plan.awaiting_approval" };
    const payload = `${line(first).trimEnd()}\r\n${line(second)}${line(terminal)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks([
          payload.slice(0, 17),
          payload.slice(17, 51),
          payload.slice(51),
        ]),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "awaiting-review",
      events: [first, second, terminal],
      hadReportDraft: false,
    });
  });

  it("reassembles a multibyte Chinese value split inside one UTF-8 code point", async () => {
    const chineseEvent: ResearchEvent = {
      type: "plan.started",
      question: "浏览器渲染正在变化。",
    };
    const terminal: ResearchEvent = { type: "plan.awaiting_approval" };
    const payload = `${line(chineseEvent)}${line(terminal)}`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(payload);
    const chineseStart = encoder.encode(payload.slice(0, payload.indexOf("浏"))).length;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromByteChunks([
          bytes.slice(0, chineseStart + 1),
          bytes.slice(chineseStart + 1),
        ]),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "awaiting-review",
      events: [chineseEvent, terminal],
      hadReportDraft: false,
    });
  });

  it("fails safely on malformed UTF-8 while preserving prior valid events", async () => {
    const prior: ResearchEvent = {
      type: "plan.started",
      question: input.question,
    };
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromByteChunks(
          [
            new TextEncoder().encode(line(prior)),
            Uint8Array.from([0xe4, 0xb8, 0x0a]),
          ],
          cancelled,
        ),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "failed",
      events: [prior, localFailure("Research stream protocol error.")],
      hadReportDraft: false,
      error: "Research stream protocol error.",
    });
    expect(result.current.run.error).not.toContain("228");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["research.partial", "partial"],
    ["research.cancelled", "cancelled"],
    ["research.failed", "failed"],
  ] as const)("maps %s to %s", async (type, status) => {
    const terminal: ResearchEvent =
      type === "research.partial"
        ? { type, report, reason: "Source limit reached." }
        : type === "research.failed"
          ? { type, message: "Safe server error.", recoverable: false }
          : { type };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(responseFromChunks([line(terminal)])),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    await act(() => result.current.approvePlan(proposedPlan));

    expect(result.current.run.status).toBe(status);
    expect(result.current.run.events.at(-1)).toEqual(terminal);
    expect(result.current.run.error).toBe(
      type === "research.failed" ? "Safe server error." : undefined,
    );
  });

  it.each([
    [
      { type: "report.completed", report } satisfies ResearchEvent,
      "completed",
      undefined,
    ],
    [
      {
        type: "research.partial",
        report,
        reason: "Source limit reached.",
      } satisfies ResearchEvent,
      "partial",
      undefined,
    ],
    [
      { type: "research.cancelled" } satisfies ResearchEvent,
      "cancelled",
      undefined,
    ],
    [
      {
        type: "research.failed",
        message: "Safe server error.",
        recoverable: false,
      } satisfies ResearchEvent,
      "failed",
      "Safe server error.",
    ],
  ] as const)(
    "keeps the first %s terminal outcome when the next stream read fails",
    async (terminal, status, error) => {
      const stream = deferredResponse();
      vi.stubGlobal(
        "fetch",
        vi.fn()
          .mockResolvedValueOnce(planReviewResponse())
          .mockResolvedValueOnce(stream.response),
      );
      const { result } = renderHook(() => useResearchStream());
      await act(() => result.current.start(input));
      let promise!: Promise<void>;
      act(() => {
        promise = result.current.approvePlan(proposedPlan);
      });

      act(() => stream.enqueue(line(terminal)));
      await waitFor(() => expect(result.current.run.events.at(-1)).toEqual(terminal));
      act(() => stream.error(new Error("transport tail secret")));
      await act(() => promise);

      expect(result.current.run.status).toBe(status);
      expect(result.current.run.events.at(-1)).toEqual(terminal);
      expect(result.current.run.error).toBe(error);
      expect(JSON.stringify(result.current.run)).not.toContain("transport tail secret");
    },
  );

  it("sets running immediately and posts parsed input with JSON headers and a signal", async () => {
    const stream = deferredResponse();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });

    expect(result.current.run).toEqual({
      status: "running",
      events: [],
      hadReportDraft: false,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan", input }),
      signal: expect.any(AbortSignal),
    });
    act(() => stream.enqueue(line({ type: "research.cancelled" })));
    act(() => stream.close());
    await act(() => promise);
  });

  it("applies schema defaults while preserving explicit input options", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseFromChunks([line({ type: "research.cancelled" })]),
      )
      .mockResolvedValueOnce(
        responseFromChunks([line({ type: "research.cancelled" })]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());
    const defaultedRequest: ResearchRequest = { question: input.question };
    const explicitRequest: ResearchRequest = {
      ...input,
      timeRange: "week",
      depth: "deep",
    };

    await act(() => result.current.start(defaultedRequest));
    await act(() => result.current.start(explicitRequest));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: "plan",
      input: {
        question: input.question,
        timeRange: "year",
        depth: "quick",
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      action: "plan",
      input: {
        question: input.question,
        timeRange: "week",
        depth: "deep",
      },
    });
  });

  it("releases the reader lock exactly once after normal completion", async () => {
    const stream = responseWithReaderSpies([
      line({ type: "plan.awaiting_approval" }),
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("awaiting-review");
    expect(stream.cancel).not.toHaveBeenCalled();
    expect(stream.releaseLock).toHaveBeenCalledOnce();
  });

  it("cancels and releases the reader once after a protocol failure", async () => {
    const stream = responseWithReaderSpies(["not-json\n"]);
    stream.releaseLock.mockImplementationOnce(() => {
      throw new Error("release-lock-secret");
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "failed",
      events: [localFailure("Research stream protocol error.")],
      hadReportDraft: false,
      error: "Research stream protocol error.",
    });
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.releaseLock).toHaveBeenCalledOnce();
  });

  it("fails safely for invalid input before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    await act(() =>
      result.current.start({ ...input, question: "short" } as ResearchInput),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.error).toBe("Invalid research request.");
    expect(result.current.run.events).toEqual([
      localFailure("Invalid research request.", false),
    ]);
  });

  it("fails safely for a non-OK response without exposing its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("provider-api-key-secret", { status: 503 }),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "failed",
      events: [localFailure("Research request failed.")],
      hadReportDraft: false,
      error: "Research request failed.",
    });
    expect(JSON.stringify(result.current.run)).not.toContain("provider-api-key-secret");
  });

  it("appends a local cancellation after already received public events", async () => {
    const stream = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const { result } = renderHook(() => useResearchStream());
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });
    act(() =>
      stream.enqueue(line({ type: "plan.started", question: input.question })),
    );
    await waitFor(() => expect(result.current.run.events).toHaveLength(1));

    act(() => result.current.cancel());
    stream.error(new DOMException("aborted", "AbortError"));
    await act(() => promise);

    expect(result.current.run).toEqual({
      status: "cancelled",
      events: [
        { type: "plan.started", question: input.question },
        { type: "research.cancelled" },
      ],
      hadReportDraft: false,
    });
  });

  it("appends a sanitized failure after a protocol error without duplicating prior events", async () => {
    const prior: ResearchEvent = {
      type: "plan.started",
      question: input.question,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(responseFromChunks([line(prior), "not-json\n"])),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "failed",
      events: [
        prior,
        localFailure("Research stream protocol error."),
      ],
      hadReportDraft: false,
      error: "Research stream protocol error.",
    });
  });

  it.each([
    ["an incomplete final record", line({ type: "plan.started", question: input.question }).trimEnd()],
    ["a blank record", `\n${line({ type: "research.cancelled" })}`],
    ["invalid JSON", `not-json\n`],
    ["a schema-invalid event", `${JSON.stringify({ type: "plan.started" })}\n`],
    ["a private field", `${JSON.stringify({ type: "research.cancelled", chainOfThought: "secret" })}\n`],
  ])("preserves prior events and cancels the reader after %s", async (_name, bad) => {
    const cancelled = vi.fn();
    const prior: ResearchEvent = {
      type: "plan.started",
      question: input.question,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(responseFromChunks([line(prior), bad], { onCancel: cancelled })),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run).toEqual({
      status: "failed",
      events: [prior, localFailure("Research stream protocol error.")],
      hadReportDraft: false,
      error: "Research stream protocol error.",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["a second terminal", line({ type: "research.cancelled" })],
    ["a record after the terminal", line({ type: "plan.started", question: input.question })],
  ])("cancels the reader after %s but keeps the first terminal authoritative", async (_name, trailingRecord) => {
    const terminal: ResearchEvent = { type: "research.cancelled" };
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks(
          [line(terminal), trailingRecord],
          { onCancel: cancelled },
        ),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("cancelled");
    expect(result.current.run.events).toEqual([terminal]);
    expect(result.current.run.error).toBeUndefined();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("ignores a local cancel after a server terminal has already been accepted", async () => {
    const terminal: ResearchEvent = { type: "report.completed", report };
    const stream = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(planReviewResponse())
        .mockResolvedValueOnce(stream.response),
    );
    const { result } = renderHook(() => useResearchStream());
    await act(() => result.current.start(input));
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.approvePlan(proposedPlan);
    });

    act(() => stream.enqueue(line(terminal)));
    await waitFor(() => expect(result.current.run.events.at(-1)).toEqual(terminal));
    act(() => result.current.cancel());
    stream.error(new DOMException("aborted", "AbortError"));
    await act(() => promise);

    expect(result.current.run.status).toBe("completed");
    expect(result.current.run.events.at(-1)).toEqual(terminal);
    expect(result.current.run.hadReportDraft).toBe(false);
  });

  it("cancels promptly, aborts the request, and does not overwrite a terminal run", async () => {
    const stream = deferredResponse();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });

    act(() => result.current.cancel());

    expect(result.current.run.status).toBe("cancelled");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    stream.error(new DOMException("aborted", "AbortError"));
    await act(() => promise);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks([line({ type: "plan.awaiting_approval" })]),
      ),
    );
    await act(() => result.current.start(input));
    act(() => result.current.cancel());
    expect(result.current.run.status).toBe("awaiting-review");
  });

  it("ignores late chunks after a local cancellation", async () => {
    const stream = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));
    const { result } = renderHook(() => useResearchStream());
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });

    act(() => result.current.cancel());
    act(() => stream.enqueue(line({ type: "report.completed", report })));
    act(() => stream.close());
    await act(() => promise);

    expect(result.current.run).toEqual({
      status: "cancelled",
      events: [{ type: "research.cancelled" }],
      hadReportDraft: false,
    });
  });

  it("reset aborts an active request and returns to idle with no events", async () => {
    const stream = deferredResponse();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });

    act(() => result.current.reset());

    expect(result.current.run).toEqual({
      status: "idle",
      events: [],
      hadReportDraft: false,
    });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    stream.error(new DOMException("aborted", "AbortError"));
    await act(() => promise);
  });

  it("isolates a second start from stale chunks and errors from the first", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());
    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = result.current.start(input);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      secondPromise = result.current.start({
        ...input,
        question: "What changed in JavaScript engines this year?",
      });
    });

    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    act(() => second.enqueue(line({ type: "plan.awaiting_approval" })));
    act(() => second.close());
    await act(() => secondPromise);
    first.error(new Error("stale secret"));
    await act(() => firstPromise);
    expect(result.current.run.status).toBe("awaiting-review");
    expect(result.current.run.events).toEqual([
      { type: "plan.awaiting_approval" },
    ]);
  });

  it("aborts an active request on unmount", () => {
    const stream = deferredResponse();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useResearchStream());
    act(() => {
      void result.current.start(input);
    });

    unmount();

    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("continues accepting events after the Strict Mode effect probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks([line({ type: "plan.awaiting_approval" })]),
      ),
    );
    const { result } = renderHook(() => useResearchStream(), {
      wrapper: StrictMode,
    });

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("awaiting-review");
  });

  it("maps abort caused by cancel to cancelled and sanitizes unrelated fetch errors", async () => {
    let rejectFetch!: (error: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectFetch = reject;
          }),
      ),
    );
    const { result } = renderHook(() => useResearchStream());
    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });
    act(() => result.current.cancel());
    rejectFetch(new DOMException("aborted", "AbortError"));
    await act(() => promise);
    expect(result.current.run.status).toBe("cancelled");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("sk-live-provider-secret")),
    );
    await act(() => result.current.start(input));
    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.error).toBe("Unable to complete research.");
    expect(result.current.run.events).toEqual([
      localFailure("Unable to complete research."),
    ]);
    expect(result.current.run.error).not.toContain("secret");
  });

  it.each([
    ["a missing body", new Response(null)],
    ["a reader error", responseFromChunks([line({ type: "plan.started", question: input.question })], { failAfter: 1 })],
  ])("fails generically for %s", async (_name, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.error).toBe("Research stream failed.");
    expect(result.current.run.events.at(-1)).toEqual(
      localFailure("Research stream failed."),
    );
  });

  it("reports EOF without a Request Terminal as a protocol failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks([
          line({ type: "plan.started", question: input.question }),
        ]),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.error).toBe("Research stream protocol error.");
  });

  it("retries the last valid request from scratch", async () => {
    const terminal: ResearchEvent = { type: "plan.awaiting_approval" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(responseFromChunks([line(terminal)]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));
    expect(result.current.run.status).toBe("failed");
    await act(() => result.current.retry());

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/research",
      expect.objectContaining({
        body: JSON.stringify({ action: "plan", input }),
      }),
    );
    expect(result.current.run).toEqual({
      status: "awaiting-review",
      events: [terminal],
      hadReportDraft: false,
    });
  });
});
