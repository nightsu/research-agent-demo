import { describe, expect, it } from "vitest";

import {
  createResearchState,
  reduceResearchState,
} from "./research-state";
import type { ResearchAction } from "./research-state";
import type {
  ResearchPhase,
  ResearchPlan,
  ResearchReport,
  Source,
} from "./research-types";
import { sourceEvaluationSchema } from "./research-types";

const plan: ResearchPlan = {
  objective: "Compare the agent capabilities of Kimi and DeepSeek",
  subquestions: ["How do their research workflows differ?"],
  searchQueries: ["Kimi agent DeepSeek agent comparison"],
};

const source = (id: string, url: string): Source => ({
  id,
  title: `Source ${id}`,
  url,
  domain: "example.com",
  snippet: "A useful comparison source.",
});

const report: ResearchReport = {
  title: "Kimi and DeepSeek agents",
  executiveSummary: "The agents emphasize different research workflows.",
  findings: [
    {
      claim: "Their workflows differ.",
      sourceIds: ["source-1"],
      confidence: "medium",
    },
  ],
  trends: [],
  disagreements: [],
  limitations: [],
};

const terminalCases: Array<{
  action: ResearchAction;
  phase: ResearchPhase;
}> = [
  { action: { type: "report.completed", payload: { report } }, phase: "completed" },
  {
    action: {
      type: "research.partial",
      payload: { report, reason: "A source was unavailable." },
    },
    phase: "partial",
  },
  {
    action: {
      type: "research.cancelled",
      payload: { reason: "Cancelled by the user." },
    },
    phase: "cancelled",
  },
  {
    action: {
      type: "research.failed",
      payload: { error: "Search provider failed." },
    },
    phase: "failed",
  },
];

describe("research workflow state", () => {
  it("starts in planning and stores a completed plan before searching", () => {
    const initial = createResearchState("Compare Kimi and DeepSeek agents");

    expect(initial.phase).toBe("planning");

    const next = reduceResearchState(initial, {
      type: "plan.completed",
      payload: plan,
    });

    expect(next.phase).toBe("searching");
    expect(next.plan).toEqual(plan);
    expect(next.stepCount).toBe(1);
  });

  it("deduplicates search sources by canonical URL", () => {
    const initial = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "searching" as const,
    };
    const firstStarted = reduceResearchState(initial, {
      type: "search.started",
      payload: { query: "agent documentation" },
    });
    const afterFirstSearch = reduceResearchState(firstStarted, {
      type: "search.completed",
      payload: {
        query: "agent documentation",
        sources: [source("source-1", "https://example.com/docs/")],
      },
    });
    const evaluated = reduceResearchState(afterFirstSearch, {
      type: "sources.evaluated",
      payload: { evaluations: [] },
    });
    const assessed = reduceResearchState(evaluated, {
      type: "evidence.assessed",
      payload: {
        sufficient: false,
        summary: "More evidence is required.",
        gaps: ["More evidence is required."],
      },
    });
    const afterGap = reduceResearchState(assessed, {
      type: "gap.detected",
      payload: { gap: "Find another agent documentation source." },
    });
    const secondStarted = reduceResearchState(afterGap, {
      type: "search.started",
      payload: { query: "agent docs" },
    });
    const afterSecondSearch = reduceResearchState(secondStarted, {
      type: "search.completed",
      payload: {
        query: "agent docs",
        sources: [source("source-2", "https://example.com/docs")],
      },
    });

    expect(afterSecondSearch.sources).toEqual([
      source("source-1", "https://example.com/docs/"),
    ]);
    expect(afterSecondSearch.stepCount).toBe(7);
  });

  it("runs the next planned search after evaluating the prior query", () => {
    const planned = reduceResearchState(
      createResearchState("Compare Kimi and DeepSeek agents"),
      { type: "plan.completed", payload: plan },
    );
    const firstSearchStarted = reduceResearchState(planned, {
      type: "search.started",
      payload: { query: "Kimi agent documentation" },
    });
    const firstSearchCompleted = reduceResearchState(firstSearchStarted, {
      type: "search.completed",
      payload: {
        query: "Kimi agent documentation",
        sources: [source("source-1", "https://example.com/kimi")],
      },
    });
    const evaluated = reduceResearchState(firstSearchCompleted, {
      type: "sources.evaluated",
      payload: { evaluations: [] },
    });
    const assessed = reduceResearchState(evaluated, {
      type: "evidence.assessed",
      payload: {
        sufficient: false,
        summary: "The second planned query is still needed.",
        gaps: [],
      },
    });

    const secondSearchStarted = reduceResearchState(assessed, {
      type: "search.started",
      payload: { query: "DeepSeek agent documentation" },
    });
    const secondSearchCompleted = reduceResearchState(secondSearchStarted, {
      type: "search.completed",
      payload: {
        query: "DeepSeek agent documentation",
        sources: [source("source-2", "https://example.com/deepseek")],
      },
    });

    expect(secondSearchStarted.phase).toBe("searching");
    expect(secondSearchStarted.stepCount).toBe(6);
    expect(secondSearchCompleted.phase).toBe("evaluating");
    expect(secondSearchCompleted.stepCount).toBe(7);
    expect(secondSearchCompleted.sources).toHaveLength(2);
  });

  it("replaces a previous source evaluation with the same sourceId", () => {
    const initial = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "evaluating" as const,
    };
    const firstEvaluation = {
      sourceId: "source-1",
      decision: "rejected" as const,
      relevance: 2,
      authority: 3,
      freshness: 4,
      reason: "Only loosely related.",
    };
    const replacement = {
      ...firstEvaluation,
      decision: "accepted" as const,
      relevance: 5,
      reason: "Directly addresses the research question.",
    };
    const evaluated = reduceResearchState(initial, {
      type: "sources.evaluated",
      payload: { evaluations: [firstEvaluation] },
    });

    const reevaluated = reduceResearchState(evaluated, {
      type: "sources.evaluated",
      payload: { evaluations: [replacement] },
    });

    expect(reevaluated.evaluations).toEqual([replacement]);
    expect(reevaluated.stepCount).toBe(2);
  });

  it("merges extracted content into an existing source without adding a new source", () => {
    const existing = source("source-1", "https://example.com/docs/");
    const initial = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "evaluating" as const,
      sources: [existing],
    };

    const next = reduceResearchState(initial, {
      type: "sources.read",
      payload: {
        sources: [{ ...existing, url: "https://example.com/docs", rawContent: "Full text" }],
      },
    });

    expect(next.sources).toEqual([
      { ...existing, url: "https://example.com/docs", rawContent: "Full text" },
    ]);
    expect(next.phase).toBe("evaluating");
  });

  it("requires fresh evaluation after source content is read", () => {
    const existing = source("source-1", "https://example.com/docs");
    const initial = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "evaluating" as const,
      sources: [existing],
      sourcesEvaluated: true,
    };

    const read = reduceResearchState(initial, {
      type: "sources.read",
      payload: { sources: [{ ...existing, rawContent: "New full text" }] },
    });
    const assessedWithoutReevaluation = reduceResearchState(read, {
      type: "evidence.assessed",
      payload: { sufficient: true, summary: "Enough.", gaps: [] },
    });

    expect(read).toMatchObject({
      sourcesEvaluated: false,
      evidenceSufficient: undefined,
      evidenceSummary: undefined,
    });
    expect(assessedWithoutReevaluation).toBe(read);
  });

  it.each(terminalCases)("moves $action.type to the $phase terminal phase", ({
    action,
    phase,
  }) => {
    const requiredPhase =
      action.type === "report.completed" || action.type === "research.partial"
        ? "synthesizing"
        : "planning";
    const next = reduceResearchState(
      {
        ...createResearchState("Compare Kimi and DeepSeek agents"),
        phase: requiredPhase,
      },
      action,
    );

    expect(next.phase).toBe(phase);
    expect(next.stepCount).toBe(1);
  });

  it("rejects completing a report directly from planning", () => {
    const initial = createResearchState("Compare Kimi and DeepSeek agents");

    const next = reduceResearchState(initial, {
      type: "report.completed",
      payload: { report },
    });

    expect(next).toBe(initial);
  });

  it("rejects skipped search and assessment boundaries", () => {
    const planned = reduceResearchState(
      createResearchState("Compare Kimi and DeepSeek agents"),
      { type: "plan.completed", payload: plan },
    );
    const skippedStart = reduceResearchState(planned, {
      type: "search.completed",
      payload: { query: "agent docs", sources: [] },
    });
    const started = reduceResearchState(planned, {
      type: "search.started",
      payload: { query: "agent docs" },
    });
    const duplicateStart = reduceResearchState(started, {
      type: "search.started",
      payload: { query: "other docs" },
    });
    const completed = reduceResearchState(started, {
      type: "search.completed",
      payload: { query: "agent docs", sources: [] },
    });
    const skippedAssessment = reduceResearchState(completed, {
      type: "synthesis.started",
      payload: {},
    });

    expect(skippedStart).toBe(planned);
    expect(duplicateStart).toBe(started);
    expect(skippedAssessment).toBe(completed);
  });

  it("rejects evidence mutations after assessment until another search", () => {
    const assessed = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "evaluating" as const,
      sources: [source("source-1", "https://example.com/docs")],
      sourcesEvaluated: true,
      evidenceAssessed: true,
    };

    const lateRead = reduceResearchState(assessed, {
      type: "sources.read",
      payload: {
        sources: [{ ...assessed.sources[0], rawContent: "Late content" }],
      },
    });
    const lateEvaluation = reduceResearchState(assessed, {
      type: "sources.evaluated",
      payload: { evaluations: [] },
    });

    expect(lateRead).toBe(assessed);
    expect(lateEvaluation).toBe(assessed);
  });

  it("stores the latest evidence sufficiency and observable summary", () => {
    const evaluated = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "evaluating" as const,
      sourcesEvaluated: true,
    };

    const assessed = reduceResearchState(evaluated, {
      type: "evidence.assessed",
      payload: {
        sufficient: false,
        summary: "A primary source is still missing.",
        gaps: ["Missing primary source"],
      },
    });

    expect(assessed).toMatchObject({
      evidenceAssessed: true,
      evidenceSufficient: false,
      evidenceSummary: "A primary source is still missing.",
      gaps: ["Missing primary source"],
    });
  });

  it("keeps validation and repair transitions in synthesizing with new state snapshots", () => {
    const evaluated = {
      ...createResearchState("Compare Kimi and DeepSeek agents"),
      phase: "evaluating" as const,
      sourcesEvaluated: true,
      evidenceAssessed: true,
    };
    const synthesizing = reduceResearchState(evaluated, {
      type: "synthesis.started",
      payload: {},
    });
    const validating = reduceResearchState(synthesizing, {
      type: "synthesis.validating",
      payload: {},
    });
    const repairing = reduceResearchState(validating, {
      type: "synthesis.repairing",
      payload: {},
    });

    expect(synthesizing).not.toBe(evaluated);
    expect(validating).not.toBe(synthesizing);
    expect(repairing).not.toBe(validating);
    expect([synthesizing.phase, validating.phase, repairing.phase]).toEqual([
      "synthesizing",
      "synthesizing",
      "synthesizing",
    ]);
    expect(repairing.stepCount).toBe(evaluated.stepCount + 3);
  });

  it("rejects validation and repair outside synthesis and after a terminal transition", () => {
    const planning = createResearchState("Compare Kimi and DeepSeek agents");
    const synthesizing = {
      ...planning,
      phase: "synthesizing" as const,
    };
    const completed = reduceResearchState(synthesizing, {
      type: "report.completed",
      payload: { report },
    });

    expect(reduceResearchState(planning, {
      type: "synthesis.validating",
      payload: {},
    })).toBe(planning);
    expect(reduceResearchState(planning, {
      type: "synthesis.repairing",
      payload: {},
    })).toBe(planning);
    expect(reduceResearchState(completed, {
      type: "synthesis.validating",
      payload: {},
    })).toBe(completed);
    expect(reduceResearchState(completed, {
      type: "synthesis.repairing",
      payload: {},
    })).toBe(completed);
  });

  it.each(["completed", "partial", "cancelled", "failed"] as const)(
    "keeps the %s phase unchanged after a later action",
    (phase) => {
      const terminal = {
        ...createResearchState("Compare Kimi and DeepSeek agents"),
        phase,
        stepCount: 4,
      };

      const next = reduceResearchState(terminal, {
        type: "plan.completed",
        payload: plan,
      });

      expect(next).toBe(terminal);
    },
  );

  it.each(["planning", "searching", "evaluating", "synthesizing"] as const)(
    "accepts cancellation and failure from the %s phase",
    (phase) => {
      const state = {
        ...createResearchState("Compare Kimi and DeepSeek agents"),
        phase,
      };

      const cancelled = reduceResearchState(state, {
        type: "research.cancelled",
        payload: { reason: "Cancelled by the user." },
      });
      const failed = reduceResearchState(state, {
        type: "research.failed",
        payload: { error: "Provider unavailable." },
      });

      expect(cancelled).toMatchObject({ phase: "cancelled", stepCount: 1 });
      expect(failed).toMatchObject({ phase: "failed", stepCount: 1 });
    },
  );

  it("rejects a blank sourceId in a source evaluation", () => {
    expect(() =>
      sourceEvaluationSchema.parse({
        sourceId: "   ",
        decision: "accepted",
        relevance: 5,
        authority: 4,
        freshness: 3,
        reason: "Relevant source.",
      }),
    ).toThrow();
  });
});
