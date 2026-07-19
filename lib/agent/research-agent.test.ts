import { describe, expect, it, vi } from "vitest";

import {
  defaultResearchLimits,
  quickResearchLimits,
  researchLimitsSchema,
} from "./limits";
import { researchEventSchema, type ResearchEvent } from "./research-events";
import type {
  EvidenceAssessment,
  ResearchInput,
  ResearchPlan,
  ResearchReport,
  Source,
  SourceEvaluation,
} from "./research-types";
import type { ResearchModel } from "../providers/research-model";
import { TavilyError } from "../tools/tavily";
import {
  proposeResearchPlan,
  runResearch,
  type ResearchDependencies,
} from "./research-agent";

const input: ResearchInput = {
  question: "How do bounded research agents work?",
  timeRange: "year",
  depth: "quick",
};

const source = (id: string, url = `https://example.com/${id}`): Source => ({
  id,
  title: `Source ${id}`,
  url,
  domain: "example.com",
  snippet: `Snippet for ${id}`,
});

const evaluation = (sourceId: string): SourceEvaluation => ({
  sourceId,
  decision: "accepted",
  relevance: 5,
  authority: 4,
  freshness: 4,
  reason: "Direct and credible evidence.",
});

const reportFor = (sourceId: string): ResearchReport => ({
  title: "Bounded research agents",
  executiveSummary: "They make explicit, bounded decisions.",
  findings: [{ claim: "The loop is bounded.", sourceIds: [sourceId], confidence: "high" }],
  trends: [],
  disagreements: [],
  limitations: [],
});

const plan = (queries = ["bounded research agent"]): ResearchPlan => ({
  objective: "Explain bounded research agents",
  subquestions: ["How is the workflow bounded?"],
  searchQueries: queries,
});

function model(overrides: Partial<ResearchModel> = {}): ResearchModel {
  const implementation: ResearchModel = {
    generatePlan: vi.fn(async () => plan()),
    evaluateSources: vi.fn(async (_question, sources) => sources.map((item: Source) => evaluation(item.id))),
    assessEvidence: vi.fn(async (): Promise<EvidenceAssessment> => ({
      sufficient: true,
      summary: "Enough evidence is available.",
      gaps: [],
      followUpQueries: [],
    })),
    generateReport: vi.fn(async (_question, sources, _evaluations, _partial, options) => {
      const report = sources[0]
        ? reportFor(sources[0].id)
        : { ...reportFor("unused"), findings: [] };
      await options?.onPartialReport?.({ title: report.title });
      await options?.onPartialReport?.(report);
      await options?.onValidating?.();
      return report;
    }),
    ...overrides,
  };
  const withoutCallHook = (options: Parameters<ResearchModel["generatePlan"]>[1]) =>
    options ? { ...options, onModelCall: undefined } : options;

  return {
    generatePlan: vi.fn((question, options) => {
      options?.onModelCall?.();
      return implementation.generatePlan(question, withoutCallHook(options));
    }),
    evaluateSources: vi.fn((question, sources, options) => {
      options?.onModelCall?.();
      return implementation.evaluateSources(question, sources, withoutCallHook(options));
    }),
    assessEvidence: vi.fn((question, sources, evaluations, options) => {
      options?.onModelCall?.();
      return implementation.assessEvidence(
        question,
        sources,
        evaluations,
        withoutCallHook(options),
      );
    }),
    generateReport: vi.fn((question, sources, evaluations, partial, options) => {
      options?.onModelCall?.();
      return implementation.generateReport(
        question,
        sources,
        evaluations,
        partial,
        withoutCallHook(options),
      );
    }),
  };
}

function harness(overrides: Partial<ResearchDependencies> = {}) {
  const events: ResearchEvent[] = [];
  const deps: ResearchDependencies = {
    model: model(),
    approvedPlan: plan(),
    searchWeb: vi.fn(async () => [source("source-1")]),
    extractSources: vi.fn(async (urls) => new Map([[urls[0]!, "Extracted content"]])),
    emit: vi.fn(async (event) => {
      events.push(researchEventSchema.parse(event));
    }),
    ...overrides,
  };
  return { deps, events };
}

describe("research limits", () => {
  it("uses the maximum allowed timeout for quick and deep research", () => {
    expect(defaultResearchLimits.requestTimeoutMs).toBe(120_000);
    expect(quickResearchLimits.requestTimeoutMs).toBe(120_000);
    expect(researchLimitsSchema.safeParse(defaultResearchLimits).success).toBe(true);
  });
});

describe("proposeResearchPlan", () => {
  it("stops at the approval boundary after emitting a validated plan", async () => {
    const events: ResearchEvent[] = [];
    const researchModel = model();

    const result = await proposeResearchPlan(input, {
      model: researchModel,
      emit: async (event) => {
        events.push(researchEventSchema.parse(event));
      },
    });

    expect(result).toEqual(plan());
    expect(researchModel.generatePlan).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "plan.started", question: input.question },
      { type: "plan.completed", plan: plan() },
      { type: "plan.awaiting_approval" },
    ]);
  });
});

describe("runResearch", () => {
  it("rejects a missing Approved Plan before any external research", async () => {
    const { deps, events } = harness({
      approvedPlan: undefined as unknown as ResearchPlan,
    });

    await expect(runResearch(input, deps)).rejects.toThrow();

    expect(deps.model.generatePlan).not.toHaveBeenCalled();
    expect(deps.searchWeb).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "research.failed",
      recoverable: false,
    });
  });

  it("emits the explicit happy-path checkpoints and completes with a report", async () => {
    const { deps, events } = harness();

    const state = await runResearch(input, deps);

    expect(events.filter((event) => event.type !== "progress.updated").map((event) => event.type)).toEqual([
      "search.started",
      "search.completed",
      "source.read",
      "source.evaluated",
      "conclusion.updated",
      "report.started",
      "report.delta",
      "report.delta",
      "report.validating",
      "report.completed",
    ]);
    expect(events.filter((event) => event.type.startsWith("report."))).toEqual([
      { type: "report.started", partial: false },
      {
        type: "report.delta",
        sequence: 0,
        mode: "append",
        text: "# Bounded research agents",
      },
      {
        type: "report.delta",
        sequence: 1,
        mode: "append",
        text: expect.stringContaining("## Executive summary"),
      },
      { type: "report.validating" },
      { type: "report.completed", report: reportFor("source-1") },
    ]);
    expect(state).toMatchObject({ phase: "completed", report: reportFor("source-1") });
    expect(state.sources[0]?.rawContent).toBe("Extracted content");
  });

  it("emits repairing after validation and the final draft delta", async () => {
    const researchModel = model({
      generateReport: vi.fn(async (_question, sources, _evaluations, _partial, options) => {
        const report = reportFor(sources[0]!.id);
        await options?.onPartialReport?.({ title: report.title });
        await options?.onValidating?.();
        await options?.onRepairing?.();
        return report;
      }),
    });
    const { deps, events } = harness({ model: researchModel });

    await runResearch(input, deps);

    expect(events.filter((event) => event.type.startsWith("report.")).map((event) => event.type)).toEqual([
      "report.started",
      "report.delta",
      "report.validating",
      "report.repairing",
      "report.completed",
    ]);
  });

  it("does not emit late report updates after cancellation", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    let lateCallbacksSettled!: () => void;
    const lateCallbacks = new Promise<void>((resolve) => {
      lateCallbacksSettled = resolve;
    });
    const researchModel = model({
      generateReport: vi.fn(async (_question, sources, _evaluations, _partial, options) => {
        providerSignal = options?.abortSignal;
        await options?.onPartialReport?.({ title: "Delivered draft" });
        controller.abort(new DOMException("user stopped", "AbortError"));
        await Promise.resolve();
        await options?.onPartialReport?.({ title: "Late draft" }).catch(() => undefined);
        await options?.onValidating?.().catch(() => undefined);
        lateCallbacksSettled();
        return reportFor(sources[0]!.id);
      }),
    });
    const { deps, events } = harness({ model: researchModel });

    const state = await runResearch(input, deps, controller.signal);
    await lateCallbacks;

    const cancellationIndex = events.findIndex((event) => event.type === "research.cancelled");
    expect(state.phase).toBe("cancelled");
    expect(providerSignal?.aborted).toBe(true);
    expect(cancellationIndex).toBeGreaterThan(-1);
    expect(events.slice(cancellationIndex + 1)).toEqual([]);
    expect(events.filter((event) => [
      "report.completed",
      "research.partial",
      "research.cancelled",
      "research.failed",
    ].includes(event.type))).toEqual([{ type: "research.cancelled" }]);
  });

  it("increments report sequence only after successful delta delivery", async () => {
    const researchModel = model({
      generateReport: vi.fn(async (_question, sources, _evaluations, _partial, options) => {
        await options?.onPartialReport?.({ title: "Undelivered draft" })
          .catch(() => undefined);
        await options?.onPartialReport?.({ title: "Delivered draft" });
        await options?.onValidating?.();
        return reportFor(sources[0]!.id);
      }),
    });
    const events: ResearchEvent[] = [];
    let rejectedFirstDelta = false;
    const emit = vi.fn(async (event: ResearchEvent) => {
      if (event.type === "report.delta" && !rejectedFirstDelta) {
        rejectedFirstDelta = true;
        throw new Error("draft delivery failed");
      }
      events.push(researchEventSchema.parse(event));
    });
    const { deps } = harness({ model: researchModel, emit });

    await runResearch(input, deps);

    expect(events.filter((event) => event.type === "report.delta")).toEqual([{
      type: "report.delta",
      sequence: 0,
      mode: "append",
      text: "# Delivered draft",
    }]);
  });

  it("numbers only accepted sources in streamed report citations without gaps", async () => {
    const rejected = source("rejected");
    const accepted = source("accepted");
    const researchModel = model({
      evaluateSources: vi.fn(async () => [{
        ...evaluation(rejected.id),
        decision: "rejected" as const,
      }, evaluation(accepted.id)]),
      generateReport: vi.fn(async (_question, _sources, _evaluations, _partial, options) => {
        await options?.onPartialReport?.({
          title: "Accepted evidence",
          findings: [{
            claim: "Only accepted evidence receives a citation number.",
            sourceIds: [accepted.id, rejected.id],
            confidence: "high",
          }],
        });
        await options?.onValidating?.();
        return reportFor(accepted.id);
      }),
    });
    const { deps, events } = harness({
      model: researchModel,
      searchWeb: vi.fn(async () => [rejected, accepted]),
    });

    await runResearch(input, deps);

    const draft = events.find(
      (event): event is Extract<ResearchEvent, { type: "report.delta" }> =>
        event.type === "report.delta",
    );
    expect(draft?.text).toContain(
      "Only accepted evidence receives a citation number. (confidence: high) [1]",
    );
    expect(draft?.text).not.toContain("[2]");
    expect(draft?.text).not.toContain(rejected.id);
  });

  it("queues one unique gap follow-up and avoids duplicate planned queries", async () => {
    const assessEvidence = vi
      .fn<ResearchModel["assessEvidence"]>()
      .mockResolvedValueOnce({
        sufficient: false,
        summary: "A comparison is missing.",
        gaps: ["Missing comparison"],
        followUpQueries: ["follow up", "planned query", "follow up"],
      })
      .mockResolvedValueOnce({
        sufficient: true,
        summary: "The comparison is now supported.",
        gaps: [],
        followUpQueries: [],
      });
    const researchModel = model({
      assessEvidence,
    });
    const searchWeb = vi.fn(async (query: string) => [source(`source-${query.replaceAll(" ", "-")}`)]);
    const { deps, events } = harness({
      model: researchModel,
      approvedPlan: plan(["planned query", "planned query"]),
      searchWeb,
      limits: { maxSteps: 12, maxSearchRounds: 5, maxResultsPerRound: 6, maxSourcesToRead: 12, requestTimeoutMs: 30_000 },
    });

    await runResearch(input, deps);

    expect(searchWeb.mock.calls.map(([query]) => query)).toEqual(["planned query", "follow up"]);
    expect(events.filter((event) => event.type === "gap.detected")).toEqual([
      {
        type: "gap.detected",
        description: "Missing comparison",
        followUpQueries: ["follow up"],
      },
    ]);
  });

  it("emits actual operation and search-round metrics throughout a two-round flow", async () => {
    const researchModel = model({
      assessEvidence: vi
        .fn<ResearchModel["assessEvidence"]>()
        .mockResolvedValueOnce({ sufficient: false, summary: "More needed.", gaps: [], followUpQueries: [] })
        .mockResolvedValueOnce({ sufficient: true, summary: "Enough.", gaps: [], followUpQueries: [] }),
    });
    const { deps, events } = harness({
      model: researchModel,
      approvedPlan: plan(["first query", "second query"]),
      searchWeb: vi.fn(async (query: string) => [source(`source-${query[0]}`)]),
      limits: { maxSteps: 12, maxSearchRounds: 3, maxResultsPerRound: 6, maxSourcesToRead: 12, requestTimeoutMs: 30_000 },
    });

    await runResearch(input, deps);

    const metrics = events.filter(
      (event): event is Extract<ResearchEvent, { type: "progress.updated" }> =>
        event.type === "progress.updated",
    );
    expect(metrics.some((event) => event.searchRounds === 1)).toBe(true);
    expect(metrics.some((event) => event.searchRounds === 2)).toBe(true);
    expect(metrics.at(-1)).toEqual({
      type: "progress.updated",
      operationCount: 9,
      operationLimit: 12,
      searchRounds: 2,
      searchRoundLimit: 3,
    });
    const terminalIndex = events.findIndex((event) => event.type === "report.completed");
    const finalProgressIndex = events.findLastIndex(
      (event) => event.type === "progress.updated",
    );
    expect(events[finalProgressIndex]).toEqual(metrics.at(-1));
    expect(finalProgressIndex).toBeLessThan(terminalIndex);
  });

  it("continues the queued plan when assessment has no follow-up queries", async () => {
    const researchModel = model({
      assessEvidence: vi
        .fn<ResearchModel["assessEvidence"]>()
        .mockResolvedValueOnce({
          sufficient: false,
          summary: "More planned evidence is needed.",
          gaps: [],
          followUpQueries: [],
        })
        .mockResolvedValueOnce({ sufficient: true, summary: "Enough.", gaps: [], followUpQueries: [] }),
    });
    const searchWeb = vi.fn(async (query: string) => [source(`source-${query[0]}`)]);
    const { deps, events } = harness({
      model: researchModel,
      approvedPlan: plan(["first query", "second query"]),
      searchWeb,
      limits: { maxSteps: 12, maxSearchRounds: 5, maxResultsPerRound: 6, maxSourcesToRead: 12, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(searchWeb.mock.calls.map(([query]) => query)).toEqual(["first query", "second query"]);
    expect(events.some((event) => event.type === "gap.detected")).toBe(false);
    expect(state.phase).toBe("completed");
  });

  it("stops at bounded rounds and emits a deterministic partial report", async () => {
    const researchModel = model({
      assessEvidence: vi.fn(async () => ({
        sufficient: false,
        summary: "Still incomplete.",
        gaps: ["Need more evidence"],
        followUpQueries: ["another query"],
      })),
    });
    const searchWeb = vi.fn(async (query: string) => [source(`source-${query[0]}`)]);
    const { deps, events } = harness({
      model: researchModel,
      searchWeb,
      limits: { maxSteps: 12, maxSearchRounds: 2, maxResultsPerRound: 6, maxSourcesToRead: 12, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(searchWeb).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "report.started", partial: true });
    expect(events.filter((event) =>
      event.type.startsWith("report.") || event.type === "research.partial"
    ).map((event) => event.type)).toEqual([
      "report.started",
      "report.delta",
      "report.delta",
      "report.validating",
      "research.partial",
    ]);
    expect(events.at(-1)?.type).toBe("research.partial");
    expect(state).toMatchObject({ phase: "partial", report: expect.any(Object) });
  });

  it("reserves the final operation step for a partial report", async () => {
    const researchModel = model({
      assessEvidence: vi.fn(async () => ({
        sufficient: false,
        summary: "Still incomplete.",
        gaps: ["Need more evidence"],
        followUpQueries: ["next query"],
      })),
    });
    const searchWeb = vi.fn(async () => [source("source-1")]);
    const { deps, events } = harness({
      model: researchModel,
      searchWeb,
      limits: { maxSteps: 6, maxSearchRounds: 5, maxResultsPerRound: 6, maxSourcesToRead: 12, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(researchModel.generateReport).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: "research.partial",
      reason: "Research operation step limit reached",
    });
    expect(state.phase).toBe("partial");
  });

  it("retries search exactly once only for a recoverable TavilyError", async () => {
    const searchWeb = vi
      .fn<ResearchDependencies["searchWeb"]>()
      .mockRejectedValueOnce(new TavilyError("temporary", { recoverable: true }))
      .mockResolvedValueOnce([source("source-1")]);
    const { deps } = harness({ searchWeb, limits: { maxSteps: 9, maxSearchRounds: 2, maxResultsPerRound: 6, maxSourcesToRead: 12, requestTimeoutMs: 30_000 } });

    await runResearch(input, deps);

    expect(searchWeb).toHaveBeenCalledTimes(2);
  });

  it("uses at most one recoverable Tavily retry across all planned queries", async () => {
    const searchWeb = vi
      .fn<ResearchDependencies["searchWeb"]>()
      .mockRejectedValueOnce(new TavilyError("first temporary", { recoverable: true }))
      .mockResolvedValueOnce([source("source-1")])
      .mockRejectedValueOnce(new TavilyError("second temporary", { recoverable: true }));
    const researchModel = model({
      assessEvidence: vi
        .fn<ResearchModel["assessEvidence"]>()
        .mockResolvedValueOnce({
          sufficient: false,
          summary: "The second planned query is required.",
          gaps: [],
          followUpQueries: [],
        }),
    });
    const { deps, events } = harness({
      model: researchModel,
      approvedPlan: plan(["first query", "second query"]),
      searchWeb,
      limits: { maxSteps: 20, maxSearchRounds: 5, maxResultsPerRound: 6, maxSourcesToRead: 0, requestTimeoutMs: 30_000 },
    });

    await expect(runResearch(input, deps)).rejects.toThrow("second temporary");

    expect(searchWeb.mock.calls.map(([query]) => query)).toEqual([
      "first query",
      "first query",
      "second query",
    ]);
    expect(events.at(-1)).toEqual({
      type: "research.failed",
      message: "The search service is temporarily unavailable.",
      recoverable: true,
    });
  });

  it("retries within an exact budget when extraction is disabled", async () => {
    const searchWeb = vi
      .fn<ResearchDependencies["searchWeb"]>()
      .mockRejectedValueOnce(new TavilyError("temporary", { recoverable: true }))
      .mockResolvedValueOnce([source("source-1")]);
    const { deps } = harness({
      searchWeb,
      limits: { maxSteps: 8, maxSearchRounds: 1, maxResultsPerRound: 6, maxSourcesToRead: 0, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(searchWeb).toHaveBeenCalledTimes(2);
    expect(deps.extractSources).not.toHaveBeenCalled();
    expect(state.phase).toBe("completed");
  });

  it.each([
    new TavilyError("bad request", { recoverable: false }),
    new DOMException("Aborted", "AbortError"),
  ])("does not retry a non-recoverable or abort error", async (error) => {
    const searchWeb = vi.fn(async () => { throw error; });
    const { deps } = harness({ searchWeb });

    await expect(runResearch(input, deps)).rejects.toBe(error);
    expect(searchWeb).toHaveBeenCalledTimes(1);
  });

  it("deduplicates sources, caps round results and reads, and skips missing extraction output", async () => {
    const results = [
      source("one", "https://example.com/one/"),
      source("duplicate", "https://example.com/one"),
      source("two"),
      source("three"),
    ];
    const extractSources = vi.fn(async (urls: string[]) => new Map([[urls[0]!, "Readable"]]));
    const researchModel = model({
      evaluateSources: vi.fn(async (_question, sources) => sources.map((item: Source) => evaluation(item.id))),
    });
    const { deps, events } = harness({
      model: researchModel,
      searchWeb: vi.fn(async () => results),
      extractSources,
      limits: { maxSteps: 8, maxSearchRounds: 1, maxResultsPerRound: 3, maxSourcesToRead: 2, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(state.sources.map((item) => item.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(extractSources).toHaveBeenCalledWith(
      ["https://example.com/one/", "https://example.com/two"],
      input.question,
      expect.any(AbortSignal),
    );
    expect(events.filter((event) => event.type === "source.read")).toHaveLength(1);
  });

  it("evaluates only sources that do not already have a current evaluation", async () => {
    const evaluateSources = vi.fn<ResearchModel["evaluateSources"]>(
      async (_question, sources) => sources.map((item) => evaluation(item.id)),
    );
    const researchModel = model({
      evaluateSources,
      assessEvidence: vi
        .fn<ResearchModel["assessEvidence"]>()
        .mockResolvedValueOnce({
          sufficient: false,
          summary: "A second source is required.",
          gaps: ["Missing second source"],
          followUpQueries: ["second query"],
        })
        .mockResolvedValueOnce({
          sufficient: true,
          summary: "Both sources are supported.",
          gaps: [],
          followUpQueries: [],
        }),
    });
    const searchWeb = vi.fn(async (query: string) =>
      query === "second query"
        ? [
            source("duplicate-first", "https://example.com/source-first/#again"),
            source("source-second"),
          ]
        : [source("source-first")],
    );
    const { deps, events } = harness({
      model: researchModel,
      searchWeb,
      extractSources: vi.fn(async () => new Map()),
      limits: {
        maxSteps: 12,
        maxSearchRounds: 2,
        maxResultsPerRound: 6,
        maxSourcesToRead: 0,
        requestTimeoutMs: 30_000,
      },
    });

    const state = await runResearch(input, deps);

    expect(
      evaluateSources.mock.calls.map(([, sources]) =>
        sources.map((item) => item.id),
      ),
    ).toEqual([["source-first"], ["source-second"]]);
    expect(state.evaluations.map((item) => item.sourceId)).toEqual([
      "source-first",
      "source-second",
    ]);
    expect(
      events
        .filter((event) => event.type === "source.evaluated")
        .map((event) => event.evaluation.sourceId),
    ).toEqual(["source-first", "source-second"]);
  });

  it("skips reevaluation when a follow-up search adds no new source", async () => {
    const evaluateSources = vi.fn<ResearchModel["evaluateSources"]>(
      async (_question, sources) => sources.map((item) => evaluation(item.id)),
    );
    const assessEvidence = vi
      .fn<ResearchModel["assessEvidence"]>()
      .mockResolvedValueOnce({
        sufficient: false,
        summary: "Recheck the existing source.",
        gaps: ["Follow-up required"],
        followUpQueries: ["duplicate query"],
      })
      .mockResolvedValueOnce({
        sufficient: true,
        summary: "The retained evaluation is sufficient.",
        gaps: [],
        followUpQueries: [],
      });
    const researchModel = model({ evaluateSources, assessEvidence });
    const { deps, events } = harness({
      model: researchModel,
      searchWeb: vi.fn(async (query: string) => [
        query === "duplicate query"
          ? source("duplicate", "https://example.com/source-1/#duplicate")
          : source("source-1"),
      ]),
      extractSources: vi.fn(async () => new Map()),
      limits: {
        maxSteps: 12,
        maxSearchRounds: 2,
        maxResultsPerRound: 6,
        maxSourcesToRead: 0,
        requestTimeoutMs: 30_000,
      },
    });

    const state = await runResearch(input, deps);

    expect(evaluateSources).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === "source.evaluated"),
    ).toHaveLength(1);
    expect(
      assessEvidence.mock.calls.map(([, sources, evaluations]) => ({
        sourceIds: sources.map((item) => item.id),
        evaluationIds: evaluations.map((item) => item.sourceId),
      })),
    ).toEqual([
      { sourceIds: ["source-1"], evaluationIds: ["source-1"] },
      { sourceIds: ["source-1"], evaluationIds: ["source-1"] },
    ]);
    expect(state.evaluations.map((item) => item.sourceId)).toEqual(["source-1"]);
  });

  it("deduplicates against existing sources before applying the round result cap", async () => {
    const existing = source("existing", "https://example.com/existing");
    const novel = source("novel", "https://example.com/novel");
    const searchWeb = vi.fn(async (query: string) =>
      query === "second query"
        ? [
            source("duplicate-existing", "https://example.com/existing/#copy"),
            novel,
          ]
        : [existing],
    );
    const extractSources = vi.fn(async (urls: string[]) =>
      new Map(urls.map((url) => [url, `Read ${url}`])),
    );
    const researchModel = model({
      assessEvidence: vi
        .fn<ResearchModel["assessEvidence"]>()
        .mockResolvedValueOnce({
          sufficient: false,
          summary: "A novel source is required.",
          gaps: ["Missing novel source"],
          followUpQueries: ["second query"],
        })
        .mockResolvedValueOnce({
          sufficient: true,
          summary: "The novel source was retained.",
          gaps: [],
          followUpQueries: [],
        }),
    });
    const { deps, events } = harness({
      model: researchModel,
      searchWeb,
      extractSources,
      limits: {
        maxSteps: 12,
        maxSearchRounds: 2,
        maxResultsPerRound: 1,
        maxSourcesToRead: 2,
        requestTimeoutMs: 30_000,
      },
    });

    const state = await runResearch(input, deps);

    expect(state.sources.map((item) => item.id)).toEqual(["existing", "novel"]);
    expect(
      events
        .filter((event) => event.type === "search.completed")
        .map((event) => event.sources.map((item) => item.id)),
    ).toEqual([["existing"], ["novel"]]);
    expect(extractSources.mock.calls.map(([urls]) => urls)).toEqual([
      ["https://example.com/existing"],
      ["https://example.com/novel"],
    ]);
    expect(
      events
        .filter((event) => event.type === "source.read")
        .map((event) => event.sourceId),
    ).toEqual(["existing", "novel"]);
  });

  it("fails and rejects when a report cites an unknown or rejected source", async () => {
    const researchModel = model({
      generateReport: vi.fn(async () => reportFor("unknown-source")),
    });
    const { deps, events } = harness({ model: researchModel });

    await expect(runResearch(input, deps)).rejects.toThrow(/accepted source/i);

    expect(events.at(-1)).toMatchObject({ type: "research.failed", recoverable: false });
    expect(events.some((event) => event.type === "report.completed")).toBe(false);
  });

  it.each([
    ["NaN steps", { maxSteps: Number.NaN }],
    ["infinite steps", { maxSteps: Number.POSITIVE_INFINITY }],
    ["fractional steps", { maxSteps: 2.5 }],
    ["too few steps", { maxSteps: 1 }],
    ["negative rounds", { maxSearchRounds: -1 }],
    ["fractional results", { maxResultsPerRound: 1.5 }],
    ["negative reads", { maxSourcesToRead: -1 }],
    ["zero timeout", { requestTimeoutMs: 0 }],
    ["infinite timeout", { requestTimeoutMs: Number.POSITIVE_INFINITY }],
    ["too many steps", { maxSteps: 101 }],
    ["too many rounds", { maxSearchRounds: 21 }],
    ["too many results", { maxResultsPerRound: 21 }],
    ["too many reads", { maxSourcesToRead: 21 }],
    ["timeout above maximum", { requestTimeoutMs: 120_001 }],
  ])("rejects invalid limits before external calls: %s", async (_label, limits) => {
    const { deps, events } = harness({ limits });

    await expect(runResearch(input, deps)).rejects.toThrow();

    expect(deps.model.generatePlan).not.toHaveBeenCalled();
    expect(deps.searchWeb).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: "research.failed",
      message: "Invalid research configuration.",
      recoverable: false,
    });
  });

  it("accepts zero for optional work caps while preserving report capacity", async () => {
    const { deps } = harness({
      limits: {
        maxSteps: 2,
        maxSearchRounds: 0,
        maxResultsPerRound: 0,
        maxSourcesToRead: 0,
        requestTimeoutMs: 1,
      },
    });

    const state = await runResearch(input, deps);

    expect(deps.model.generatePlan).not.toHaveBeenCalled();
    expect(deps.searchWeb).not.toHaveBeenCalled();
    expect(state.phase).toBe("partial");
  });

  it("sanitizes dependency failures while rejecting the original error", async () => {
    const secret = "SECRET_API_KEY raw provider request payload";
    const error = new Error(secret);
    const researchModel = model({ evaluateSources: vi.fn(async () => { throw error; }) });
    const { deps, events } = harness({ model: researchModel });

    await expect(runResearch(input, deps)).rejects.toBe(error);

    const failure = events.at(-1);
    expect(failure).toEqual({
      type: "research.failed",
      message: "A research dependency failed.",
      recoverable: false,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("commits each source.read event independently before a later delivery fails", async () => {
    const events: ResearchEvent[] = [];
    let readCount = 0;
    const emit = vi.fn(async (event: ResearchEvent) => {
      if (event.type === "source.read" && ++readCount === 2) {
        throw new Error("second read delivery failed");
      }
      events.push(researchEventSchema.parse(event));
    });
    const extractSources = vi.fn(async (urls: string[]) =>
      new Map(urls.map((url, index) => [url, `Content ${index}`])),
    );
    const { deps } = harness({
      emit,
      extractSources,
      searchWeb: vi.fn(async () => [source("one"), source("two")]),
    });

    await expect(runResearch(input, deps)).rejects.toThrow("second read delivery failed");

    expect(events.filter((event) => event.type === "source.read")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "research.failed" });
  });

  it("commits each source.evaluated event independently before a later delivery fails", async () => {
    const events: ResearchEvent[] = [];
    let evaluationCount = 0;
    const emit = vi.fn(async (event: ResearchEvent) => {
      if (event.type === "source.evaluated" && ++evaluationCount === 2) {
        throw new Error("second evaluation delivery failed");
      }
      events.push(researchEventSchema.parse(event));
    });
    const { deps } = harness({
      emit,
      searchWeb: vi.fn(async () => [source("one"), source("two")]),
      extractSources: vi.fn(async () => new Map()),
    });

    await expect(runResearch(input, deps)).rejects.toThrow(
      "second evaluation delivery failed",
    );

    expect(events.filter((event) => event.type === "source.evaluated")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "research.failed" });
  });

  it("returns partial when the model claims sufficiency without any source", async () => {
    const { deps, events } = harness({
      searchWeb: vi.fn(async () => []),
      extractSources: vi.fn(async () => new Map()),
    });

    const state = await runResearch(input, deps);

    expect(state.evidenceSufficient).toBe(false);
    expect(state.phase).toBe("partial");
    expect(events.at(-1)?.type).toBe("research.partial");
  });

  it("returns partial when all known source evaluations are rejected", async () => {
    const researchModel = model({
      evaluateSources: vi.fn(async (_question, sources) =>
        sources.map((item: Source) => ({
          ...evaluation(item.id),
          decision: "rejected" as const,
        })),
      ),
      generateReport: vi.fn(async () => ({ ...reportFor("unused"), findings: [] })),
    });
    const { deps, events } = harness({ model: researchModel });

    const state = await runResearch(input, deps);

    expect(state.evidenceSufficient).toBe(false);
    expect(state.phase).toBe("partial");
    expect(events.at(-1)?.type).toBe("research.partial");
  });

  it("marks exhausted recoverable Tavily failures as recoverable", async () => {
    const searchWeb = vi.fn(async () => {
      throw new TavilyError("temporary", { recoverable: true });
    });
    const { deps, events } = harness({ searchWeb });

    await expect(runResearch(input, deps)).rejects.toThrow("temporary");

    expect(searchWeb).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({
      type: "research.failed",
      message: "The search service is temporarily unavailable.",
      recoverable: true,
    });
  });

  it("emits a nonempty fallback message and preserves an empty-message error", async () => {
    const error = new Error();
    const researchModel = model({ evaluateSources: vi.fn(async () => { throw error; }) });
    const { deps, events } = harness({ model: researchModel });

    await expect(runResearch(input, deps)).rejects.toBe(error);

    expect(events.at(-1)).toEqual({
      type: "research.failed",
      message: "A research dependency failed.",
      recoverable: false,
    });
  });

  it("emits failure if terminal event delivery rejects", async () => {
    const emitterError = new Error("stream closed");
    const events: ResearchEvent[] = [];
    const emit = vi.fn(async (event: ResearchEvent) => {
      if (event.type === "report.completed") throw emitterError;
      events.push(researchEventSchema.parse(event));
    });
    const { deps } = harness({ emit });

    await expect(runResearch(input, deps)).rejects.toBe(emitterError);

    expect(events.at(-1)).toEqual({
      type: "research.failed",
      message: "A research dependency failed.",
      recoverable: false,
    });
  });

  it("returns cancelled before calls and during a call without throwing", async () => {
    const before = new AbortController();
    before.abort("user stopped");
    const beforeHarness = harness();

    const beforeState = await runResearch(input, beforeHarness.deps, before.signal);

    expect(beforeState.phase).toBe("cancelled");
    expect(beforeHarness.deps.model.generatePlan).not.toHaveBeenCalled();
    expect(beforeHarness.events).toEqual([{ type: "research.cancelled" }]);

    const during = new AbortController();
    const searchWeb = vi.fn((_query, _options, signal) => new Promise<Source[]>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const duringHarness = harness({ searchWeb });
    const pending = runResearch(input, duringHarness.deps, during.signal);
    await vi.waitFor(() => expect(searchWeb).toHaveBeenCalled());
    during.abort(new DOMException("user stopped", "AbortError"));

    const duringState = await pending;

    expect(duringState.phase).toBe("cancelled");
    expect(duringHarness.events.at(-1)?.type).toBe("research.cancelled");
  });

  it("passes abort signals to every dependency call", async () => {
    const seenSignals: AbortSignal[] = [];
    const researchModel = model({
      evaluateSources: vi.fn(async (_question, sources, options) => { seenSignals.push(options!.abortSignal!); return sources.map((item: Source) => evaluation(item.id)); }),
      assessEvidence: vi.fn(async (_question, _sources, _evaluations, options) => { seenSignals.push(options!.abortSignal!); return { sufficient: true, summary: "Enough.", gaps: [], followUpQueries: [] }; }),
      generateReport: vi.fn(async (_question, sources, _evaluations, _partial, options) => { seenSignals.push(options!.abortSignal!); return reportFor(sources[0]!.id); }),
    });
    const searchWeb = vi.fn(async (_query, _options, signal) => { seenSignals.push(signal!); return [source("source-1")]; });
    const extractSources = vi.fn(async (urls, _question, signal) => { seenSignals.push(signal!); return new Map([[urls[0]!, "content"]]); });
    const { deps } = harness({ model: researchModel, searchWeb, extractSources });

    await runResearch(input, deps);

    expect(seenSignals).toHaveLength(5);
    expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("counts an execution model repair callback as another operation step", async () => {
    const emptyReport: ResearchReport = {
      ...reportFor("unused"),
      findings: [],
    };
    const repairAwareModel: ResearchModel = {
      generatePlan: vi.fn(async () => plan()),
      evaluateSources: vi.fn(async (_question, sources, options) => {
        options?.onModelCall?.();
        options?.onModelCall?.();
        return sources.map((item: Source) => evaluation(item.id));
      }),
      assessEvidence: vi.fn(async (_question, _sources, _evaluations, options) => {
        options?.onModelCall?.();
        return { sufficient: true, summary: "Enough.", gaps: [], followUpQueries: [] };
      }),
      generateReport: vi.fn(async (_question, _sources, _evaluations, _partial, options) => {
        options?.onModelCall?.();
        return emptyReport;
      }),
    };
    const { deps, events } = harness({
      model: repairAwareModel,
      limits: { maxSteps: 5, maxSearchRounds: 2, maxResultsPerRound: 6, maxSourcesToRead: 0, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(deps.searchWeb).toHaveBeenCalledTimes(1);
    expect(deps.extractSources).not.toHaveBeenCalled();
    expect(state.phase).toBe("partial");
    const executionMetrics = events.filter(
      (event): event is Extract<ResearchEvent, { type: "progress.updated" }> =>
        event.type === "progress.updated",
    );
    expect(executionMetrics.map((event) => event.operationCount)).toContain(2);
  });

  it("reserves two report calls and returns partial under a tight repair budget", async () => {
    const repairedReport = { ...reportFor("unused"), findings: [] };
    const repairAwareModel: ResearchModel = {
      generatePlan: vi.fn(async (_question, options) => {
        options?.onModelCall?.();
        return plan();
      }),
      evaluateSources: vi.fn(async (_question, sources, options) => {
        options?.onModelCall?.();
        options?.onModelCall?.();
        return sources.map((item: Source) => evaluation(item.id));
      }),
      assessEvidence: vi.fn(async (_question, _sources, _evaluations, options) => {
        options?.onModelCall?.();
        options?.onModelCall?.();
        return { sufficient: false, summary: "Budget-limited evidence.", gaps: [], followUpQueries: [] };
      }),
      generateReport: vi.fn(async (_question, _sources, _evaluations, partial, options) => {
        expect(partial).toBe(true);
        options?.onModelCall?.();
        options?.onModelCall?.();
        return repairedReport;
      }),
    };
    const { deps, events } = harness({
      model: repairAwareModel,
      limits: { maxSteps: 6, maxSearchRounds: 2, maxResultsPerRound: 6, maxSourcesToRead: 6, requestTimeoutMs: 30_000 },
    });

    const state = await runResearch(input, deps);

    expect(state.phase).toBe("partial");
    expect(events.at(-1)?.type).toBe("research.partial");
    expect(repairAwareModel.generateReport).toHaveBeenCalledTimes(1);
  });

  it("cancels while an event delivery is pending", async () => {
    const controller = new AbortController();
    const events: ResearchEvent[] = [];
    const emit = vi.fn((event: ResearchEvent) => {
      if (event.type === "search.started") return new Promise<void>(() => {});
      events.push(researchEventSchema.parse(event));
    });
    const { deps } = harness({ emit });
    const pending = runResearch(input, deps, controller.signal);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "search.started" })),
    );

    controller.abort(new DOMException("user stopped", "AbortError"));
    const state = await pending;

    expect(state.phase).toBe("cancelled");
    expect(events.at(-1)?.type).toBe("research.cancelled");
  });

  it("aborts a timed-out request and classifies the failure as recoverable", async () => {
    let receivedSignal: AbortSignal | undefined;
    const researchModel = model({
      evaluateSources: vi.fn((_question, _sources, options) => {
        receivedSignal = options?.abortSignal;
        return new Promise<SourceEvaluation[]>((_resolve, reject) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(options.abortSignal?.reason),
            { once: true },
          );
        });
      }),
    });
    const { deps, events } = harness({
      model: researchModel,
      limits: { maxSteps: 8, maxSearchRounds: 2, maxResultsPerRound: 6, maxSourcesToRead: 6, requestTimeoutMs: 5 },
    });

    await expect(runResearch(input, deps)).rejects.toThrow(/timed out/i);

    expect(receivedSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "research.failed", recoverable: true });
  });

  it("times out a pending event delivery and emits a sanitized failure", async () => {
    const events: ResearchEvent[] = [];
    const emit = vi.fn((event: ResearchEvent) => {
      if (event.type === "search.started") return new Promise<void>(() => {});
      events.push(researchEventSchema.parse(event));
    });
    const { deps } = harness({
      emit,
      limits: { requestTimeoutMs: 5 },
    });

    await expect(runResearch(input, deps)).rejects.toThrow(/timed out/i);

    expect(events.at(-1)).toEqual({
      type: "research.failed",
      message: "A research operation timed out.",
      recoverable: true,
    });
  });

  it("rejects invalid input before making external calls and emits failure", async () => {
    const { deps, events } = harness();

    await expect(runResearch({ ...input, question: "short" }, deps)).rejects.toThrow();

    expect(deps.model.generatePlan).not.toHaveBeenCalled();
    expect(deps.searchWeb).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "research.failed", recoverable: false });
  });

  it("emits failure for a missing runtime input before external calls", async () => {
    const { deps, events } = harness();

    await expect(
      runResearch(undefined as unknown as ResearchInput, deps),
    ).rejects.toThrow();

    expect(deps.model.generatePlan).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "research.failed", recoverable: false });
  });
});
