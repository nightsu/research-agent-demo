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
    const initial = createResearchState("Compare Kimi and DeepSeek agents");
    const afterFirstSearch = reduceResearchState(initial, {
      type: "search.completed",
      payload: {
        query: "agent documentation",
        sources: [source("source-1", "https://example.com/docs/")],
      },
    });

    const afterSecondSearch = reduceResearchState(afterFirstSearch, {
      type: "search.completed",
      payload: {
        query: "agent docs",
        sources: [source("source-2", "https://example.com/docs")],
      },
    });

    expect(afterSecondSearch.sources).toEqual([
      source("source-1", "https://example.com/docs/"),
    ]);
    expect(afterSecondSearch.stepCount).toBe(2);
  });

  it("replaces a previous source evaluation with the same sourceId", () => {
    const initial = createResearchState("Compare Kimi and DeepSeek agents");
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

  it.each(terminalCases)("moves $action.type to the $phase terminal phase", ({
    action,
    phase,
  }) => {
    const next = reduceResearchState(
      createResearchState("Compare Kimi and DeepSeek agents"),
      action,
    );

    expect(next.phase).toBe(phase);
    expect(next.stepCount).toBe(1);
  });
});
