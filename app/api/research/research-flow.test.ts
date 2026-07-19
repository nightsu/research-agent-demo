import { describe, expect, it, vi } from "vitest";

import { deriveResearchViewModel } from "../../../components/research/research-view-model";
import {
  createResearchFlowFixture,
  researchFlowAcceptedSourceIds,
  researchFlowFollowUpQuery,
  researchFlowInitialQuery,
  researchFlowInput,
  researchFlowPlan,
  researchFlowRejectedSourceId,
} from "../../../lib/agent/research-fixtures";
import { runResearch } from "../../../lib/agent/research-agent";
import {
  decodeEventLine,
  type ResearchEvent,
} from "../../../lib/agent/research-events";
import type { ResearchState } from "../../../lib/agent/research-state";
import type { ResearchReport } from "../../../lib/agent/research-types";
import { createResearchRoute } from "../../../lib/server/research-route";

const terminalTypes = new Set<ResearchEvent["type"]>([
  "report.completed",
  "research.partial",
  "research.cancelled",
  "research.failed",
]);

const cancellationReport: ResearchReport = {
  title: "Cancelled report",
  executiveSummary: "This late provider result must not become terminal output.",
  findings: [{
    claim: "Kimi exposes a structured tool protocol.",
    sourceIds: [researchFlowAcceptedSourceIds[0]],
    confidence: "high",
  }],
  trends: [],
  disagreements: [],
  limitations: [],
};

async function readRemainingEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstChunk: Uint8Array,
): Promise<{ events: ResearchEvent[]; serialized: string }> {
  const decoder = new TextDecoder();
  let serialized = decoder.decode(firstChunk, { stream: true });

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    serialized += decoder.decode(next.value, { stream: true });
  }
  serialized += decoder.decode();

  return {
    events: serialized
      .split("\n")
      .filter(Boolean)
      .map((line) => decodeEventLine(`${line}\n`)),
    serialized,
  };
}

async function executeFixture() {
  const fixture = createResearchFlowFixture();
  const generateReport = fixture.model.generateReport.bind(fixture.model);
  fixture.model.generateReport = async (
    question,
    sources,
    evaluations,
    partial,
    modelOptions,
  ) => {
    modelOptions?.onModelCall?.();
    const reportOptions = modelOptions
      ? { ...modelOptions, onModelCall: undefined }
      : modelOptions;
    await reportOptions?.onPartialReport?.({
      title: "Kimi 与 DeepSeek Agent 工具调用开发对比",
    });
    await reportOptions?.onPartialReport?.({
      title: "Kimi 与 DeepSeek Agent 工具调用开发对比",
      executiveSummary: "两者都提供结构化工具调用。",
      findings: [{
        claim: "Kimi 与 DeepSeek 都提供官方工具调用协议。",
        sourceIds: [...researchFlowAcceptedSourceIds],
        confidence: "high",
      }],
    });
    await reportOptions?.onValidating?.();
    return generateReport(
      question,
      sources,
      evaluations,
      partial,
      reportOptions,
    );
  };
  let terminalState: ResearchState | undefined;
  const post = createResearchRoute({
    createModel: () => fixture.model,
    runResearch: async (...args) => {
      terminalState = await runResearch(...args);
      return terminalState;
    },
    searchWeb: fixture.searchWeb,
    extractSources: fixture.extractSources,
  });
  const response = await post(
    new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        input: researchFlowInput,
        plan: researchFlowPlan,
      }),
    }),
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  if (first.done) throw new Error("Research stream closed before its first event");

  return {
    fixture,
    response,
    reader,
    firstChunk: first.value,
    getTerminalState: () => terminalState,
  };
}

describe("POST /api/research complete workflow", () => {
  it("stops after proposing a plan and waits for approval before using tools", async () => {
    const fixture = createResearchFlowFixture();
    const post = createResearchRoute({
      createModel: () => fixture.model,
      runResearch,
      searchWeb: fixture.searchWeb,
      extractSources: fixture.extractSources,
    });

    const response = await post(
      new Request("http://localhost/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "plan", input: researchFlowInput }),
      }),
    );
    const events = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => decodeEventLine(`${line}\n`));

    expect(events.map((event) => event.type)).toEqual([
      "plan.started",
      "plan.completed",
      "plan.awaiting_approval",
    ]);
    expect(fixture.modelCalls).toEqual(["generatePlan"]);
    expect(fixture.toolCalls).toEqual([]);
  });

  it("executes an approved plan without asking the model to plan again", async () => {
    const fixture = createResearchFlowFixture();
    const post = createResearchRoute({
      createModel: () => fixture.model,
      runResearch,
      searchWeb: fixture.searchWeb,
      extractSources: fixture.extractSources,
    });

    const response = await post(
      new Request("http://localhost/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          input: researchFlowInput,
          plan: researchFlowPlan,
        }),
      }),
    );
    const events = (await response.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => decodeEventLine(`${line}\n`));

    expect(response.status).toBe(200);
    expect(events.at(-1)?.type).toBe("report.completed");
    expect(fixture.modelCalls).not.toContain("generatePlan");
    expect(fixture.searchCalls[0]).toEqual({
      query: researchFlowInitialQuery,
      timeRange: "year",
    });
  });

  it("streams a deterministic two-round cited report through the real route and workflow", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const firstRun = await executeFixture();

    expect(
      decodeEventLine(new TextDecoder().decode(firstRun.firstChunk)).type,
    ).toBe("progress.updated");

    const { events, serialized } = await readRemainingEvents(
      firstRun.reader,
      firstRun.firstChunk,
    );
    const eventTypes = events.map((event) => event.type);
    const terminalEvents = events.filter((event) => terminalTypes.has(event.type));
    const completed = events.at(-1);

    expect(firstRun.response.status).toBe(200);
    expect(firstRun.response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(firstRun.response.headers.get("cache-control")).toBe(
      "no-cache, no-transform",
    );
    expect(firstRun.response.headers.get("x-accel-buffering")).toBe("no");
    expect(eventTypes.filter((type) => type === "search.started")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "search.completed")).toHaveLength(2);
    expect(eventTypes).toContain("gap.detected");
    expect(eventTypes.filter((type) => type === "conclusion.updated")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "report.started")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "report.delta").length).toBeGreaterThanOrEqual(1);
    expect(eventTypes.filter((type) => type === "report.validating")).toHaveLength(1);
    expect(terminalEvents).toHaveLength(1);
    expect(completed?.type).toBe("report.completed");
    const reportDeltas = events.filter(
      (event): event is Extract<ResearchEvent, { type: "report.delta" }> =>
        event.type === "report.delta",
    );
    expect(reportDeltas.map((event) => event.sequence)).toEqual([0, 1]);
    const completedView = deriveResearchViewModel(events);
    const acceptedCitationNumbers = researchFlowAcceptedSourceIds.map(
      (sourceId) => completedView.citationNumbers.get(sourceId),
    );
    expect(acceptedCitationNumbers).toEqual([1, 2]);
    expect(
      completedView.citationNumbers.get(researchFlowRejectedSourceId),
    ).toBeUndefined();
    expect(reportDeltas.map((event) => event.text).join("")).toContain(
      acceptedCitationNumbers.map((number) => `[${number}]`).join(" "),
    );

    expect(firstRun.fixture.searchCalls).toEqual([
      { query: researchFlowInitialQuery, timeRange: "year" },
      { query: researchFlowFollowUpQuery, timeRange: "year" },
    ]);
    expect(firstRun.fixture.extractCalls).toHaveLength(2);
    expect(events.some((event) => event.type === "source.read")).toBe(true);

    const completedSearches = events.filter(
      (event): event is Extract<ResearchEvent, { type: "search.completed" }> =>
        event.type === "search.completed",
    );
    const collectedSources = completedSearches.flatMap((event) => event.sources);
    const collectedIds = new Set(collectedSources.map((source) => source.id));
    const canonicalUrls = collectedSources.map((source) => {
      const url = new URL(source.url);
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString();
    });
    expect(new Set(canonicalUrls).size).toBe(canonicalUrls.length);

    const evaluations = events
      .filter(
        (event): event is Extract<ResearchEvent, { type: "source.evaluated" }> =>
          event.type === "source.evaluated",
      )
      .map((event) => event.evaluation);
    expect(
      evaluations
        .filter((item) => item.decision === "accepted")
        .map((item) => item.sourceId),
    ).toEqual(researchFlowAcceptedSourceIds);
    expect(
      evaluations
        .filter((item) => item.decision === "rejected")
        .map((item) => item.sourceId),
    ).toEqual([researchFlowRejectedSourceId]);
    expect(new Set(evaluations.map((item) => item.sourceId)).size).toBe(
      evaluations.length,
    );
    expect(firstRun.fixture.evaluatedSourceBatches).toEqual([
      [researchFlowAcceptedSourceIds[0], researchFlowRejectedSourceId],
      [researchFlowAcceptedSourceIds[1]],
    ]);

    if (completed?.type !== "report.completed") {
      throw new Error("Expected a completed report");
    }
    const latestEvaluations = new Map(
      evaluations.map((evaluation) => [evaluation.sourceId, evaluation]),
    );
    for (const finding of completed.report.findings) {
      for (const sourceId of finding.sourceIds) {
        expect(collectedIds.has(sourceId)).toBe(true);
        expect(latestEvaluations.get(sourceId)?.decision).toBe("accepted");
      }
    }
    expect(completed.report.findings).toHaveLength(2);
    expect(completed.report.trends).not.toHaveLength(0);
    expect(completed.report.disagreements).not.toHaveLength(0);
    expect(completed.report.limitations).not.toHaveLength(0);
    expect(
      completed.report.findings.flatMap((finding) => finding.sourceIds),
    ).not.toContain(researchFlowRejectedSourceId);
    const terminalState = firstRun.getTerminalState();
    expect(terminalState).toBeDefined();
    const terminalSources = terminalState?.sources.map(
      ({ rawContent, ...source }) => {
        expect(rawContent).toBeTypeOf("string");
        return source;
      },
    );
    expect(terminalSources).toEqual(collectedSources);
    expect(terminalState?.evaluations).toEqual(evaluations);
    expect(terminalState?.report).toEqual(completed.report);

    expect(firstRun.fixture.modelCalls).toEqual([
      "evaluateSources",
      "assessEvidence",
      "evaluateSources",
      "assessEvidence",
      "generateReport",
    ]);
    expect(firstRun.fixture.modelOperationCalls).toEqual(
      firstRun.fixture.modelCalls,
    );
    expect(firstRun.fixture.modelSignals).toHaveLength(
      firstRun.fixture.modelCalls.length,
    );
    expect(firstRun.fixture.modelSignals.every((signal) => !signal.aborted)).toBe(
      true,
    );
    expect(firstRun.fixture.toolCalls).toEqual([
      "searchWeb",
      "extractSources",
      "searchWeb",
      "extractSources",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(serialized).not.toMatch(/private\.reasoning|chainOfThought|rawChain/i);

    const secondRun = await executeFixture();
    const repeated = await readRemainingEvents(
      secondRun.reader,
      secondRun.firstChunk,
    );
    const repeatedCompleted = repeated.events.at(-1);
    expect(repeated.events.map((event) => event.type)).toEqual(eventTypes);
    expect(
      repeated.events
        .filter(
          (event): event is Extract<ResearchEvent, { type: "search.completed" }> =>
            event.type === "search.completed",
        )
        .flatMap((event) => event.sources.map((source) => source.id)),
    ).toEqual(collectedSources.map((source) => source.id));
    expect(repeatedCompleted).toEqual(completed);
  });

  it("aborts the real report provider and emits one cancellation terminal", async () => {
    const fixture = createResearchFlowFixture();
    const requestController = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let draftDelivered!: () => void;
    const draftDelivery = new Promise<void>((resolve) => {
      draftDelivered = resolve;
    });
    let lateCallbackSettled!: () => void;
    const lateCallback = new Promise<void>((resolve) => {
      lateCallbackSettled = resolve;
    });
    fixture.model.generateReport = async (
      _question,
      _sources,
      _evaluations,
      _partial,
      modelOptions,
    ) => {
      modelOptions?.onModelCall?.();
      providerSignal = modelOptions?.abortSignal;
      await modelOptions?.onPartialReport?.({ title: "Delivered draft" });
      draftDelivered();
      await new Promise<void>((resolve) => {
        if (providerSignal?.aborted) resolve();
        else providerSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.resolve(
        modelOptions?.onPartialReport?.({ title: "Late draft" }),
      ).catch(() => undefined);
      lateCallbackSettled();
      return cancellationReport;
    };
    const post = createResearchRoute({
      createModel: () => fixture.model,
      runResearch,
      searchWeb: fixture.searchWeb,
      extractSources: fixture.extractSources,
    });
    const response = await post(new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        input: researchFlowInput,
        plan: researchFlowPlan,
      }),
      signal: requestController.signal,
    }));
    const reader = response.body!.getReader();
    const eventsBeforeCancellation: ResearchEvent[] = [];

    while (!eventsBeforeCancellation.some((event) => event.type === "report.delta")) {
      const next = await reader.read();
      if (next.done) throw new Error("Research stream closed before the first report delta");
      eventsBeforeCancellation.push(
        decodeEventLine(new TextDecoder().decode(next.value)),
      );
    }
    await draftDelivery;
    requestController.abort(new DOMException("client cancelled", "AbortError"));

    const remaining = await readRemainingEvents(reader, new Uint8Array());
    await lateCallback;
    const events = [...eventsBeforeCancellation, ...remaining.events];
    const terminalEvents = events.filter((event) => terminalTypes.has(event.type));
    const cancellationIndex = events.findIndex(
      (event) => event.type === "research.cancelled",
    );

    expect(providerSignal?.aborted).toBe(true);
    expect(terminalEvents).toEqual([{ type: "research.cancelled" }]);
    expect(cancellationIndex).toBeGreaterThan(-1);
    expect(events.slice(cancellationIndex + 1)).toEqual([]);
  });
});
