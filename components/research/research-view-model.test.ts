import { describe, expect, it } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { Source, SourceEvaluation } from "@/lib/agent/research-types";

import { deriveResearchViewModel, eventStatusLabel } from "./research-view-model";

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
  it.each([
    [{ type: "report.delta", sequence: 0, mode: "append", text: "# Draft" } as const, "Report draft updated"],
    [{ type: "report.validating" } as const, "Report validating"],
    [{ type: "report.repairing" } as const, "Report repairing"],
  ])("labels $event.type as a public report status", (event, label) => {
    expect(eventStatusLabel(event)).toBe(label);
  });

  it.each([
    { type: "report.delta", sequence: 0, mode: "append", text: "# Draft" } as const,
    { type: "report.validating" } as const,
    { type: "report.repairing" } as const,
  ])("keeps $type in the synthesizing phase", (event) => {
    expect(deriveResearchViewModel([event]).currentPhase).toBe("synthesizing");
  });

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

  it("numbers only latest accepted identities and gives aliases the canonical number", () => {
    const alias: Source = {
      ...sourceA,
      id: "a-alias",
      url: "https://example.com/article#accepted",
    };
    const view = deriveResearchViewModel([
      search([sourceB, sourceA]),
      search([alias]),
      evaluated(sourceB.id, "rejected"),
      evaluated(alias.id, "accepted"),
    ]);

    expect(view.sources.map((source) => source.id)).toEqual(["b", "a"]);
    expect(view.citationNumbers.get(sourceB.id)).toBeUndefined();
    expect(view.citationNumbers.get(sourceA.id)).toBe(1);
    expect(view.citationNumbers.get(alias.id)).toBe(1);
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

  it("exposes the latest workflow metrics independently of later events", () => {
    const metrics = {
      operationCount: 8,
      operationLimit: 12,
      searchRounds: 2,
      searchRoundLimit: 3,
    };
    const view = deriveResearchViewModel([
      { type: "progress.updated", ...metrics },
      { type: "research.cancelled" },
    ]);

    expect(view.metrics).toEqual(metrics);
  });
});
