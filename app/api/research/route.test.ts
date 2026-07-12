import { describe, expect, it, vi } from "vitest";

import {
  decodeEventLine,
  encodeEvent,
  type ResearchEvent,
} from "../../../lib/agent/research-events";
import type { ResearchState } from "../../../lib/agent/research-state";
import type { ResearchInput } from "../../../lib/agent/research-types";
import type { ResearchModel } from "../../../lib/providers/research-model";
import { createResearchRoute, type ResearchRouteDependencies } from "./route";

const question = "研究型智能体如何可靠地流式返回阶段性结果？";

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
  return request(JSON.stringify(body), signal);
}

async function readEvents(response: Response): Promise<ResearchEvent[]> {
  const body = await response.text();
  const lines = body.split("\n").filter(Boolean);
  return lines.map((line) => decodeEventLine(`${line}\n`));
}

describe("POST /api/research", () => {
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
        await dependencies.emit({ type: "plan.started", question: input.question });
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
    expect(decodeEventLine(decoder.decode(first.value))).toEqual({
      type: "plan.started",
      question,
    });

    releaseSecond();
    const second = await reader.read();
    const end = await reader.read();

    expect(decodeEventLine(decoder.decode(second.value))).toEqual({
      type: "research.cancelled",
    });
    expect(end).toEqual({ done: true, value: undefined });
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
        await dependencies.emit({ type: "plan.started", question: input.question });
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
