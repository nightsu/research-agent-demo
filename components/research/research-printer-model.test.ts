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

  it("projects one synthesis record while report deltas and validation phases stream", () => {
    const records = derivePrinterRecords([
      { type: "report.started", partial: false },
      { type: "report.delta", sequence: 0, mode: "append", text: "# Draft" },
      { type: "report.validating" },
      { type: "report.delta", sequence: 1, mode: "append", text: "\nEvidence" },
      { type: "report.repairing" },
    ]);

    expect(records).toEqual([
      {
        id: "synthesis-0",
        kind: "synthesis",
        partial: false,
        status: "repairing",
      },
    ]);
  });

  it.each([
    { terminal: { type: "report.completed", report: { title: "Report", executiveSummary: "Summary", findings: [], trends: [], disagreements: [], limitations: [] } } as ResearchEvent },
    { terminal: { type: "research.partial", report: { title: "Partial", executiveSummary: "Summary", findings: [], trends: [], disagreements: [], limitations: [] }, reason: "Limit reached" } as ResearchEvent },
  ])("completes the existing synthesis record for $terminal.type", ({ terminal }) => {
    const records = derivePrinterRecords([
      { type: "report.started", partial: terminal.type === "research.partial" },
      { type: "report.delta", sequence: 0, mode: "append", text: "Draft" },
      { type: "report.validating" },
      terminal,
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "synthesis", status: "complete" });
  });

  it.each([
    { terminal: { type: "research.cancelled" } as ResearchEvent, outcome: "cancelled" },
    { terminal: { type: "research.failed", message: "Safe failure", recoverable: true } as ResearchEvent, outcome: "failed" },
  ])("keeps one active synthesis card plus one $outcome terminal card", ({ terminal, outcome }) => {
    const records = derivePrinterRecords([
      { type: "report.started", partial: false },
      { type: "report.delta", sequence: 0, mode: "append", text: "Draft" },
      terminal,
    ]);

    expect(records.map((record) => record.kind)).toEqual(["synthesis", "terminal"]);
    expect(records.filter((record) => record.kind === "terminal")).toHaveLength(1);
    expect(records[1]).toMatchObject({ kind: "terminal", outcome });
  });
});
