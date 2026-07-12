import { describe, expect, it } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { Source, SourceEvaluation } from "@/lib/agent/research-types";

import { deriveResearchViewModel } from "./research-view-model";

const sourceA: Source = {
  id: "a",
  title: "Source A",
  url: "https://example.com/article/",
  domain: "example.com",
  snippet: "A",
};
const sourceB: Source = {
  id: "b",
  title: "Source B",
  url: "https://example.org/other",
  domain: "example.org",
  snippet: "B",
};

function search(sources: Source[]): ResearchEvent {
  return { type: "search.completed", query: "query", sources, resultCount: sources.length };
}

function evaluated(
  sourceId: string,
  decision: SourceEvaluation["decision"],
): ResearchEvent {
  return {
    type: "source.evaluated",
    evaluation: {
      sourceId,
      decision,
      relevance: 4,
      authority: 4,
      freshness: 4,
      reason: `${decision} now`,
    },
  };
}

describe("deriveResearchViewModel", () => {
  it("counts the latest accepted decisions across repeated search rounds", () => {
    const view = deriveResearchViewModel(
      [search([sourceA]), evaluated("a", "accepted"), search([sourceA, sourceB]), evaluated("a", "accepted"), evaluated("b", "accepted")],
    );

    expect(view.counters).toEqual({ sources: 2, accepted: 2, rejected: 0 });
    expect(view.evaluations.get("a")?.reason).toBe("accepted now");
  });

  it("replaces an earlier decision when the same source is re-evaluated", () => {
    const view = deriveResearchViewModel(
      [search([sourceA]), evaluated("a", "accepted"), evaluated("a", "rejected")],
    );

    expect(view.counters).toEqual({ sources: 1, accepted: 0, rejected: 1 });
    expect(view.evaluations.get("a")?.decision).toBe("rejected");
  });

  it("deduplicates canonical URLs and resolves alias evaluations to one source", () => {
    const duplicate: Source = {
      ...sourceA,
      id: "a-alias",
      url: "https://example.com/article#details",
      title: "Source A duplicate",
    };
    const view = deriveResearchViewModel(
      [search([sourceA]), search([duplicate]), evaluated("a-alias", "accepted")],
    );

    expect(view.sources.map((item) => item.id)).toEqual(["a"]);
    expect(view.counters).toEqual({ sources: 1, accepted: 1, rejected: 0 });
    expect(view.evaluations.get("a")?.sourceId).toBe("a-alias");
  });

  it("uses the latest workflow event so a follow-up search returns to searching", () => {
    const view = deriveResearchViewModel(
      [search([sourceA]), evaluated("a", "accepted"), { type: "gap.detected", description: "Need more", followUpQueries: ["follow up"] }, { type: "search.started", query: "follow up", reason: "Close gap" }],
    );

    expect(view.currentPhase).toBe("searching");
    expect(view.latestEvent?.type).toBe("search.started");
    expect(view.latestEventLabel).toBe("Search running");
  });

  it("preserves the interrupted workflow phase for a terminal outcome", () => {
    const view = deriveResearchViewModel(
      [
        { type: "plan.started", question: "A realistic research question" },
        {
          type: "plan.completed",
          plan: {
            objective: "Research the question",
            subquestions: ["What happened?"],
            searchQueries: ["evidence query"],
          },
        },
        { type: "search.started", query: "evidence query", reason: "Find evidence" },
        { type: "research.cancelled" },
      ],
    );
    expect(view.currentPhase).toBe("searching");
  });
});
