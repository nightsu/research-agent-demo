import { describe, expect, it, vi } from "vitest";

import {
  decodeEventLine,
  encodeEvent,
  type ResearchEvent,
} from "../../../lib/agent/research-events";
import type { ResearchState } from "../../../lib/agent/research-state";
import type {
  ResearchInput,
  ResearchPlan,
  ResearchReport,
} from "../../../lib/agent/research-types";
import type { ResearchModel } from "../../../lib/providers/research-model";
import {
  createResearchRoute,
  type ResearchRouteDependencies,
} from "../../../lib/server/research-route";
import * as routeModule from "./route";

const question = "研究型智能体如何可靠地流式返回阶段性结果？";
const routeReport: ResearchReport = {
  title: "流式研究报告",
  executiveSummary: "报告更新必须遵守背压。",
  findings: [],
  trends: [],
  disagreements: [],
  limitations: [],
};
const approvedPlan: ResearchPlan = {
  objective: "验证研究流的阶段性结果",
  subquestions: ["事件是否遵守协议？"],
  searchQueries: ["research stream protocol"],
};
const routeProgress: ResearchEvent = {
  type: "progress.updated",
  operationCount: 1,
  operationLimit: 8,
  searchRounds: 0,
  searchRoundLimit: 3,
};

function emptyState(input: ResearchInput): ResearchState {
  return {
    question: input.question,
    phase: "cancelled",
    stepCount: 0,
    sources: [],
    evaluations: [],
    evidenceAssessed: false,
    sourcesEvaluated: false,
    gaps: [],
  };
}

function harness(
  run: ResearchRouteDependencies["runResearch"] = vi.fn(
    async (input) => emptyState(input),
  ),
) {
  const model = {} as ResearchModel;
  const dependencies: ResearchRouteDependencies = {
    createModel: vi.fn(() => model),
    runResearch: run,
    searchWeb: vi.fn(),
    extractSources: vi.fn(),
  };

  return {
    dependencies,
    post: createResearchRoute(dependencies),
  };
}

function request(body: string, signal?: AbortSignal) {
  return new Request("http://localhost/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
}

function jsonRequest(body: unknown, signal?: AbortSignal) {
  return request(JSON.stringify({
    action: "execute",
    input: body,
    plan: approvedPlan,
  }), signal);
}

async function readEvents(response: Response): Promise<ResearchEvent[]> {
  const body = await response.text();
  const lines = body.split("\n").filter(Boolean);
  return lines.map((line) => decodeEventLine(`${line}\n`));
}

describe("POST /api/research", () => {
  it("exports only Next-supported route fields", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["POST", "maxDuration"]);
  });

  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["empty object", "{}"],
    ["short question", JSON.stringify({ question: "太短" })],
  ])("returns a bounded Chinese 400 error for %s without starting research", async (_label, body) => {
    const { dependencies, post } = harness();

    const response = await post(request(body));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: expect.any(String) });
    expect(payload.error).toMatch(/[\u3400-\u9fff]/u);
    expect(payload.error.length).toBeLessThanOrEqual(120);
    expect(dependencies.createModel).not.toHaveBeenCalled();
    expect(dependencies.runResearch).not.toHaveBeenCalled();
  });

  it("rejects a legacy bare research input that has not passed Plan Review", async () => {
    const { dependencies, post } = harness();

    const response = await post(request(JSON.stringify({ question })));

    expect(response.status).toBe(400);
    expect(dependencies.createModel).not.toHaveBeenCalled();
    expect(dependencies.runResearch).not.toHaveBeenCalled();
  });

  it("applies input defaults and returns explicit NDJSON streaming headers", async () => {
    const { dependencies, post } = harness();

    const response = await post(jsonRequest({ question }));
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(dependencies.runResearch).toHaveBeenCalledWith(
      { question, timeRange: "year", depth: "quick" },
      expect.objectContaining({
        model: expect.anything(),
        searchWeb: dependencies.searchWeb,
        extractSources: dependencies.extractSources,
        emit: expect.any(Function),
      }),
      expect.any(AbortSignal),
    );
  });

  it("passes explicit time range and depth to the workflow", async () => {
    const { dependencies, post } = harness();

    const response = await post(
      jsonRequest({ question, timeRange: "week", depth: "deep" }),
    );
    await response.text();

    expect(dependencies.runResearch).toHaveBeenCalledWith(
      { question, timeRange: "week", depth: "deep" },
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it("makes each emitted event available as an independently decodeable line", async () => {
    let releaseSecond!: () => void;
    const waitForSecond = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit(routeProgress);
        await waitForSecond;
        await dependencies.emit({ type: "research.cancelled" });
        return emptyState(input);
      },
    );
    const { post } = harness(run);

    const response = await post(jsonRequest({ question }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(decodeEventLine(decoder.decode(first.value))).toEqual(routeProgress);

    releaseSecond();
    const second = await reader.read();
    const end = await reader.read();

    expect(decodeEventLine(decoder.decode(second.value))).toEqual({
      type: "research.cancelled",
    });
    expect(end).toEqual({ done: true, value: undefined });
  });

  it("encodes a multilingual report delta with newlines as one NDJSON record", async () => {
    const delta: ResearchEvent = {
      type: "report.delta",
      sequence: 0,
      mode: "append",
      text: "# 研究草稿\n\n第一条结论。",
    };
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit(delta);
        await dependencies.emit({ type: "research.cancelled" });
        return emptyState(input);
      },
    );
    const { post } = harness(run);

    const serialized = await (await post(jsonRequest({ question }))).text();
    const records = serialized.split("\n").filter(Boolean);

    expect(records).toHaveLength(2);
    expect(decodeEventLine(`${records[0]}\n`)).toEqual(delta);
    expect(records[0]).toContain("研究草稿");
    expect(records[0]).toContain("\\n\\n");
  });

  it("links request aborts to the workflow signal", async () => {
    let workflowSignal!: AbortSignal;
    let resolveRun!: (state: ResearchState) => void;
    const runPending = new Promise<ResearchState>((resolve) => {
      resolveRun = resolve;
    });
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, _dependencies, signal) => {
        workflowSignal = signal!;
        return runPending.then(() => emptyState(input));
      },
    );
    const controller = new AbortController();
    const { post } = harness(run);
    const response = await post(jsonRequest({ question }, controller.signal));

    controller.abort("request stopped");

    expect(workflowSignal.aborted).toBe(true);
    expect(workflowSignal.reason).toBe("request stopped");
    resolveRun(emptyState({ question, timeRange: "year", depth: "quick" }));
    await response.text();
  });

  it("aborts the workflow when the response stream is cancelled", async () => {
    let workflowSignal!: AbortSignal;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies, signal) => {
        workflowSignal = signal!;
        await dependencies.emit(routeProgress);
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return emptyState(input);
      },
    );
    const { post } = harness(run);
    const response = await post(jsonRequest({ question }));
    const reader = response.body!.getReader();
    await reader.read();

    await reader.cancel("consumer left");

    expect(workflowSignal.aborted).toBe(true);
    expect(workflowSignal.reason).toBe("consumer left");
  });

  it("removes request abort wiring once when cancel and workflow completion race", async () => {
    const requestController = new AbortController();
    const researchRequest = jsonRequest(
      { question },
      requestController.signal,
    );
    const removeListener = vi.spyOn(researchRequest.signal, "removeEventListener");
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies, signal) => {
        await dependencies.emit(routeProgress);
        await new Promise<void>((resolve) => {
          if (signal!.aborted) resolve();
          else signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        return emptyState(input);
      },
    );
    const { post } = harness(run);
    const response = await post(researchRequest);
    const reader = response.body!.getReader();
    await reader.read();

    await reader.cancel("consumer left");
    await run.mock.results[0].value;
    await Promise.resolve();

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("closes cleanly when the workflow rejects after emitting a sanitized failure", async () => {
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (_input, dependencies) => {
        await dependencies.emit({
          type: "research.failed",
          message: "研究服务暂时不可用。",
          recoverable: true,
        });
        throw new Error("provider secret and stack trace");
      },
    );
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));

    expect(events).toEqual([
      {
        type: "research.failed",
        message: "研究服务暂时不可用。",
        recoverable: true,
      },
    ]);
  });

  it("adds one failed terminal event when research rejects after progress", async () => {
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit(routeProgress);
        throw new Error("provider secret and stack trace");
      },
    );
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));

    expect(events).toEqual([
      routeProgress,
      {
        type: "research.failed",
        message: "The research request failed.",
        recoverable: false,
      },
    ]);
  });

  it("adds one failed terminal event when research resolves after progress", async () => {
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit(routeProgress);
        return emptyState(input);
      },
    );
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));

    expect(events).toEqual([
      routeProgress,
      {
        type: "research.failed",
        message: "The research request failed.",
        recoverable: false,
      },
    ]);
  });

  it("adds a failed terminal for dependency AbortError without route cancellation", async () => {
    const dependencyAbort = new DOMException(
      "dependency stopped itself",
      "AbortError",
    );
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(async () => {
      throw dependencyAbort;
    });
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));

    expect(events).toEqual([
      {
        type: "research.failed",
        message: "The research request failed.",
        recoverable: false,
      },
    ]);
  });

  it("rejects events after the first terminal event", async () => {
    let rejectedAfterTerminal = false;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit({ type: "research.cancelled" });
        try {
          await dependencies.emit({
            type: "report.delta",
            sequence: 0,
            mode: "append",
            text: "late draft",
          });
        } catch {
          rejectedAfterTerminal = true;
        }
        return emptyState(input);
      },
    );
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));
    const terminals = events.filter((event) =>
      [
        "report.completed",
        "research.partial",
        "research.cancelled",
        "research.failed",
      ].includes(event.type),
    );

    expect(rejectedAfterTerminal).toBe(true);
    expect(events).toEqual([{ type: "research.cancelled" }]);
    expect(terminals).toHaveLength(1);
  });

  it("keeps report draft, validation, and repair events nonterminal", async () => {
    let rejectedAfterCompleted = false;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit({ type: "report.started", partial: false });
        await dependencies.emit({
          type: "report.delta",
          sequence: 0,
          mode: "append",
          text: "# Draft",
        });
        await dependencies.emit({ type: "report.validating" });
        await dependencies.emit({ type: "report.repairing" });
        await dependencies.emit({ type: "report.completed", report: routeReport });
        try {
          await dependencies.emit({ type: "report.validating" });
        } catch {
          rejectedAfterCompleted = true;
        }
        return emptyState(input);
      },
    );
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));

    expect(rejectedAfterCompleted).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "report.started",
      "report.delta",
      "report.validating",
      "report.repairing",
      "report.completed",
    ]);
  });

  it("holds a second emit until stream capacity is pulled", async () => {
    let secondAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      secondAttempted = resolve;
    });
    let secondDelivered = false;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit(routeProgress);
        secondAttempted();
        await dependencies.emit({ type: "research.cancelled" });
        secondDelivered = true;
        return emptyState(input);
      },
    );
    const { post } = harness(run);
    const response = await post(jsonRequest({ question }));

    await attempted;
    await Promise.resolve();
    expect(secondDelivered).toBe(false);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    await vi.waitFor(() => expect(secondDelivered).toBe(true));
    const second = await reader.read();
    const end = await reader.read();

    expect(decodeEventLine(decoder.decode(first.value))).toEqual(routeProgress);
    expect(decodeEventLine(decoder.decode(second.value))).toEqual({
      type: "research.cancelled",
    });
    expect(end.done).toBe(true);
  });

  it("applies consumer backpressure between consecutive report deltas", async () => {
    const deliveredSequences: number[] = [];
    let secondAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      secondAttempted = resolve;
    });
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit({
          type: "report.delta",
          sequence: 0,
          mode: "append",
          text: "first",
        });
        deliveredSequences.push(0);
        secondAttempted();
        await dependencies.emit({
          type: "report.delta",
          sequence: 1,
          mode: "append",
          text: " second",
        });
        deliveredSequences.push(1);
        await dependencies.emit({ type: "research.cancelled" });
        return emptyState(input);
      },
    );
    const { post } = harness(run);
    const response = await post(jsonRequest({ question }));

    await attempted;
    await Promise.resolve();
    expect(deliveredSequences).toEqual([0]);

    const reader = response.body!.getReader();
    await reader.read();
    await vi.waitFor(() => expect(deliveredSequences).toEqual([0, 1]));
    await reader.read();
    await reader.read();
    expect((await reader.read()).done).toBe(true);
  });

  it("rejects a capacity-blocked emit when the consumer cancels", async () => {
    let secondAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      secondAttempted = resolve;
    });
    let blockedEmitRejected = false;
    let workflowSignal!: AbortSignal;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies, signal) => {
        workflowSignal = signal!;
        await dependencies.emit(routeProgress);
        secondAttempted();
        try {
          await dependencies.emit({ type: "research.cancelled" });
        } catch {
          blockedEmitRejected = true;
        }
        return emptyState(input);
      },
    );
    const { post } = harness(run);
    const response = await post(jsonRequest({ question }));

    await attempted;
    const reader = response.body!.getReader();
    await reader.cancel("consumer left");
    await run.mock.results[0].value;

    expect(blockedEmitRejected).toBe(true);
    expect(workflowSignal.aborted).toBe(true);
    expect(workflowSignal.reason).toBe("consumer left");
  });

  it("does not backpressure a late cancellation event after an unread request disconnect", async () => {
    let firstDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => { firstDelivered = resolve; });
    let cancellationSettled = false;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies, signal) => {
        await dependencies.emit(routeProgress);
        firstDelivered();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        await Promise.resolve(dependencies.emit({ type: "research.cancelled" })).catch(() => undefined);
        cancellationSettled = true;
        return emptyState(input);
      },
    );
    const requestController = new AbortController();
    const { post } = harness(run);
    await post(jsonRequest({ question }, requestController.signal));

    await delivered;
    requestController.abort("client disconnected");
    await vi.waitFor(() => expect(cancellationSettled).toBe(true), { timeout: 200 });
    await run.mock.results[0].value;
  });

  it("emits one cancellation terminal and rejects all other events after request abort", async () => {
    let workflowStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      workflowStarted = resolve;
    });
    let nonCancellationRejected = false;
    let afterTerminalRejected = false;
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies, signal) => {
        await dependencies.emit(routeProgress);
        workflowStarted();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        try {
          await dependencies.emit({
            type: "search.started",
            query: "late query",
            reason: "abort race",
          });
        } catch {
          nonCancellationRejected = true;
        }
        await dependencies.emit({ type: "research.cancelled" });
        try {
          await dependencies.emit(routeProgress);
        } catch {
          afterTerminalRejected = true;
        }
        return emptyState(input);
      },
    );
    const controller = new AbortController();
    const { post } = harness(run);
    const response = await post(jsonRequest({ question }, controller.signal));

    await started;
    controller.abort("request stopped");
    const events = await readEvents(response);

    expect(nonCancellationRejected).toBe(true);
    expect(afterTerminalRejected).toBe(true);
    expect(events).toEqual([
      routeProgress,
      { type: "research.cancelled" },
    ]);
  });

  it("emits one sanitized failure when the workflow rejects before any event", async () => {
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(async () => {
      throw new Error("provider secret and stack trace");
    });
    const { post } = harness(run);

    const events = await readEvents(await post(jsonRequest({ question })));

    expect(events).toEqual([
      {
        type: "research.failed",
        message: "The research request failed.",
        recoverable: false,
      },
    ]);
  });

  it("returns a safe JSON error if route setup fails before streaming", async () => {
    const { dependencies, post } = harness();
    vi.mocked(dependencies.createModel).mockImplementation(() => {
      throw new Error("provider secret and stack trace");
    });

    const response = await post(jsonRequest({ question }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toContain("研究服务暂时不可用");
    expect(body).not.toContain("provider secret");
    expect(dependencies.runResearch).not.toHaveBeenCalled();
  });

  it("validates emitted events at runtime and never exposes private fields", async () => {
    const run = vi.fn<ResearchRouteDependencies["runResearch"]>(
      async (input, dependencies) => {
        await dependencies.emit({
          type: "plan.started",
          question: input.question,
          privateReasoning: "hidden chain of thought",
        } as ResearchEvent);
        return emptyState(input);
      },
    );
    const { post } = harness(run);

    const response = await post(jsonRequest({ question }));
    const body = await response.text();
    const lines = body.split("\n").filter(Boolean);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("hidden chain of thought");
    expect(decodeEventLine(`${lines[0]}\n`)).toEqual({
      type: "research.failed",
      message: "The research request failed.",
      recoverable: false,
    });
  });

  it("rejects private or structurally invalid events before encoding", () => {
    expect(() =>
      encodeEvent({
        type: "plan.started",
        question,
        privateReasoning: "hidden chain of thought",
      } as ResearchEvent),
    ).toThrow();
    expect(() =>
      encodeEvent({ type: "research.failed", message: "", recoverable: false }),
    ).toThrow();
  });
});
