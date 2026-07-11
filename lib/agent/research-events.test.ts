import { describe, expect, it } from "vitest";

import { decodeEventLine, encodeEvent, researchEventSchema } from "./research-events";

const source = {
  id: "source-1",
  title: "Kimi documentation",
  url: "https://example.com/kimi",
  domain: "example.com",
  snippet: "Official tool documentation",
};

const report = {
  title: "Kimi agents",
  executiveSummary: "Kimi supports tool-assisted research.",
  findings: [
    {
      claim: "Kimi provides agent tooling.",
      sourceIds: [source.id],
      confidence: "high" as const,
    },
  ],
  trends: [],
  disagreements: [],
  limitations: [],
};

describe("research event protocol", () => {
  it("round-trips one search.started event with exactly one trailing newline", () => {
    const event = {
      type: "search.started" as const,
      query: "Kimi agents",
      reason: "Find official tool documentation",
    };

    const encoded = encodeEvent(event);

    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.endsWith("\n\n")).toBe(false);
    expect(encoded.match(/\n/g)).toHaveLength(1);
    expect(decodeEventLine(encoded)).toEqual(event);
  });

  it("rejects private reasoning events", () => {
    expect(() => researchEventSchema.parse({ type: "private.reasoning" })).toThrow();
  });

  it.each([
    ["plan.started", { type: "plan.started", question: 42 }],
    ["plan.completed", { type: "plan.completed", plan: { objective: "", subquestions: [], searchQueries: [] } }],
    ["search.started", { type: "search.started", query: "", reason: "docs" }],
    ["search.completed", { type: "search.completed", query: "Kimi", sources: [source], resultCount: -1 }],
    ["source.read", { type: "source.read", sourceId: "", url: "not-a-url" }],
    ["source.evaluated", { type: "source.evaluated", evaluation: { sourceId: "source-1" } }],
    ["gap.detected", { type: "gap.detected", description: "missing", followUpQueries: ["one", "two", "three", "four"] }],
    ["conclusion.updated", { type: "conclusion.updated", summary: "" }],
    ["report.started", { type: "report.started", partial: "false" }],
    ["report.completed", { type: "report.completed", report: { ...report, findings: "invalid" } }],
    ["research.partial", { type: "research.partial", report, reason: "" }],
    ["research.failed", { type: "research.failed", message: "", recoverable: "yes" }],
  ])("rejects a malformed %s payload", (_type, event) => {
    expect(() => researchEventSchema.parse(event)).toThrow();
  });

  it("decodes one JSON record with one optional trailing line ending", () => {
    const event = { type: "research.cancelled" as const };
    const json = JSON.stringify(event);

    expect(decodeEventLine(json)).toEqual(event);
    expect(decodeEventLine(`${json}\n`)).toEqual(event);
    expect(decodeEventLine(`${json}\r\n`)).toEqual(event);
  });

  it.each(["", "\n", "\r\n", "  ", "{}\n{}", "{}\n\n"])(
    "rejects blank or multiple records: %j",
    (line) => {
      expect(() => decodeEventLine(line)).toThrow();
    },
  );
});
