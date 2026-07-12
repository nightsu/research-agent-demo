import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchInput } from "@/lib/agent/research-types";

import { useResearchStream } from "./use-research-stream";

const input: ResearchInput = {
  question: "What changed in browser rendering this year?",
  timeRange: "year",
  depth: "quick",
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResearchStream", () => {
  it("reassembles split JSON, multiple records, and CRLF in event order", async () => {
    const first: ResearchEvent = {
      type: "plan.started",
      question: input.question,
    };
    const second: ResearchEvent = {
      type: "conclusion.updated",
      summary: "Evidence is converging.",
    };
    const terminal: ResearchEvent = { type: "report.completed", report };
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
      status: "completed",
      events: [first, second, terminal],
    });
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
      vi.fn().mockResolvedValue(responseFromChunks([line(terminal)])),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe(status);
    expect(result.current.run.events).toEqual([terminal]);
    expect(result.current.run.error).toBe(
      type === "research.failed" ? "Safe server error." : undefined,
    );
  });

  it("sets running immediately and posts parsed input with JSON headers and a signal", async () => {
    const stream = deferredResponse();
    const fetchMock = vi.fn().mockResolvedValue(stream.response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useResearchStream());

    let promise!: Promise<void>;
    act(() => {
      promise = result.current.start(input);
    });

    expect(result.current.run).toEqual({ status: "running", events: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: expect.any(AbortSignal),
    });
    act(() => stream.enqueue(line({ type: "research.cancelled" })));
    act(() => stream.close());
    await act(() => promise);
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
      events: [],
      error: "Research request failed.",
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
      events: [prior],
      error: "Research stream protocol error.",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects a second terminal or a record after a terminal", async () => {
    const terminal: ResearchEvent = { type: "research.cancelled" };
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseFromChunks(
          [line(terminal), line({ type: "research.cancelled" })],
          { onCancel: cancelled },
        ),
      ),
    );
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.events).toEqual([terminal]);
    expect(cancelled).toHaveBeenCalledOnce();
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
        responseFromChunks([line({ type: "report.completed", report })]),
      ),
    );
    await act(() => result.current.start(input));
    act(() => result.current.cancel());
    expect(result.current.run.status).toBe("completed");
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

    expect(result.current.run).toEqual({ status: "cancelled", events: [] });
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

    expect(result.current.run).toEqual({ status: "idle", events: [] });
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
    act(() => second.enqueue(line({ type: "report.completed", report })));
    act(() => second.close());
    await act(() => secondPromise);
    first.error(new Error("stale secret"));
    await act(() => firstPromise);
    expect(result.current.run.status).toBe("completed");
    expect(result.current.run.events).toEqual([
      { type: "report.completed", report },
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
        responseFromChunks([line({ type: "report.completed", report })]),
      ),
    );
    const { result } = renderHook(() => useResearchStream(), {
      wrapper: StrictMode,
    });

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("completed");
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
    expect(result.current.run.error).not.toContain("secret");
  });

  it.each([
    ["a missing body", new Response(null)],
    ["a reader error", responseFromChunks([line({ type: "plan.started", question: input.question })], { failAfter: 1 })],
    ["EOF without a terminal", responseFromChunks([line({ type: "plan.started", question: input.question })])],
  ])("fails generically for %s", async (_name, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const { result } = renderHook(() => useResearchStream());

    await act(() => result.current.start(input));

    expect(result.current.run.status).toBe("failed");
    expect(result.current.run.error).toBe("Research stream failed.");
  });
});
