import { describe, expect, it } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { Source } from "@/lib/agent/research-types";

import { derivePrinterRecords } from "./research-printer-model";

const source: Source = {
  id: "source-1",
  title: "Primary evidence",
  url: "https://example.com/evidence",
  domain: "example.com",
  snippet: "Evidence summary",
};

const searchEvents: ResearchEvent[] = [
  { type: "search.started", query: "browser changes", reason: "Find primary evidence" },
  { type: "search.completed", query: "browser changes", sources: [source], resultCount: 4 },
  { type: "source.read", sourceId: source.id, url: source.url },
  {
    type: "source.evaluated",
    evaluation: {
      sourceId: source.id,
      decision: "accepted",
      relevance: 5,
      authority: 4,
      freshness: 5,
      reason: "Direct evidence",
    },
  },
];

describe("derivePrinterRecords", () => {
  it("groups one search round and its source lifecycle into one record", () => {
    const records = derivePrinterRecords(searchEvents);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "search",
      query: "browser changes",
      status: "complete",
      resultCount: 4,
      sources: [{ source, read: true, evaluation: { decision: "accepted" } }],
    });
  });

  it("keeps repeated queries distinct and omits progress-only records", () => {
    const records = derivePrinterRecords([
      ...searchEvents.slice(0, 2),
      { type: "progress.updated", operationCount: 2, operationLimit: 10, searchRounds: 1, searchRoundLimit: 3 },
      ...searchEvents.slice(0, 2),
    ]);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.id)).toEqual(["search-0", "search-3"]);
  });

  it("does not invent display sources for unknown source ids", () => {
    const records = derivePrinterRecords([
      ...searchEvents.slice(0, 2),
      { type: "source.read", sourceId: "unknown", url: "https://unknown.example" },
    ]);
    expect(records[0]).toMatchObject({ sources: [{ source, read: false }] });
  });

  it("keeps public workflow records ordered without leaking private fields", () => {
    const unsafe = {
      type: "conclusion.updated",
      summary: "Evidence is converging.",
      reasoning_content: "private chain",
    } as unknown as ResearchEvent;
    const records = derivePrinterRecords([
      { type: "plan.started", question: "What changed in browsers this year?" },
      { type: "gap.detected", description: "Need confirmation", followUpQueries: ["independent evidence"] },
      unsafe,
      { type: "report.started", partial: false },
      { type: "research.failed", message: "Safe public error", recoverable: true },
    ]);
    expect(records.map((record) => record.kind)).toEqual(["plan", "gap", "conclusion", "synthesis", "terminal"]);
    expect(JSON.stringify(records)).not.toContain("private chain");
  });
});
