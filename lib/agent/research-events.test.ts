import { describe, expect, it } from "vitest";

import {
  decodeEventLine,
  encodeEvent,
  researchEventSchema,
  type ResearchEvent,
} from "./research-events";
import {
  evidenceAssessmentSchema,
  researchPlanSchema,
  searchQuerySchema,
  sourceSchema,
  httpUrlSchema,
} from "./research-types";

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

const evaluation = {
  sourceId: source.id,
  decision: "accepted" as const,
  relevance: 5,
  authority: 4,
  freshness: 3,
  reason: "Relevant official documentation",
};

const validEvents: ResearchEvent[] = [
  { type: "plan.started", question: "How do Kimi agents work?" },
  { type: "progress.updated", operationCount: 1, operationLimit: 12, searchRounds: 0, searchRoundLimit: 3 },
  {
    type: "plan.completed",
    plan: {
      objective: "Understand Kimi agents",
      subquestions: ["Which tools are available?"],
      searchQueries: ["Kimi agent tools"],
    },
  },
  { type: "search.started", query: "Kimi agents", reason: "Find official documentation" },
  { type: "search.completed", query: "Kimi agents", sources: [source], resultCount: 3 },
  { type: "source.read", sourceId: source.id, url: source.url },
  { type: "source.evaluated", evaluation },
  { type: "gap.detected", description: "Pricing is unclear", followUpQueries: ["Kimi agent pricing"] },
  { type: "conclusion.updated", summary: "Kimi provides agent tools." },
  { type: "report.started", partial: false },
  { type: "report.completed", report },
  { type: "research.partial", report, reason: "One source was unavailable" },
  { type: "research.cancelled" },
  { type: "research.failed", message: "Search provider unavailable", recoverable: true },
];

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
    ["reasoning", { type: "research.cancelled", reasoning: "hidden" }],
    ["privateReasoning", { type: "research.cancelled", privateReasoning: "hidden" }],
    ["misspelled payload", { type: "search.started", query: "Kimi", reson: "docs", reason: "docs" }],
  ])("rejects otherwise-valid events with an extra %s field", (_label, event) => {
    expect(() => researchEventSchema.parse(event)).toThrow();
    expect(() => encodeEvent(event as ResearchEvent)).toThrow();
  });

  it("rejects a blank plan question", () => {
    expect(() => researchEventSchema.parse({ type: "plan.started", question: "   " })).toThrow();
  });

  it("accepts 500-character search queries across domain and event boundaries", () => {
    const query = `  ${"q".repeat(500)}  `;

    expect(searchQuerySchema.parse(query)).toHaveLength(500);
    expect(researchPlanSchema.parse({
      objective: "Test query bounds",
      subquestions: ["What is the boundary?"],
      searchQueries: [query],
    }).searchQueries[0]).toHaveLength(500);
    expect(evidenceAssessmentSchema.parse({
      sufficient: false,
      summary: "More evidence is required.",
      gaps: [],
      followUpQueries: [query],
    }).followUpQueries[0]).toHaveLength(500);
    expect(researchEventSchema.parse({
      type: "gap.detected",
      description: "More evidence is required.",
      followUpQueries: [query],
    })).toMatchObject({ followUpQueries: ["q".repeat(500)] });
  });

  it("rejects 501-character search queries across domain and event boundaries", () => {
    const query = "q".repeat(501);

    expect(() => searchQuerySchema.parse(query)).toThrow();
    expect(() => researchPlanSchema.parse({
      objective: "Test query bounds",
      subquestions: ["What is the boundary?"],
      searchQueries: [query],
    })).toThrow();
    expect(() => evidenceAssessmentSchema.parse({
      sufficient: false,
      summary: "More evidence is required.",
      gaps: [],
      followUpQueries: [query],
    })).toThrow();
    expect(() => researchEventSchema.parse({
      type: "gap.detected",
      description: "More evidence is required.",
      followUpQueries: [query],
    })).toThrow();
  });

  it("rejects an oversized public failure message", () => {
    expect(() =>
      researchEventSchema.parse({
        type: "research.failed",
        message: "x".repeat(501),
        recoverable: false,
      }),
    ).toThrow();
  });

  it("rejects invalid workflow progress metrics", () => {
    expect(() => researchEventSchema.parse({
      type: "progress.updated",
      operationCount: -1,
      operationLimit: 0,
      searchRounds: 1.5,
      searchRoundLimit: -1,
    })).toThrow();
  });

  it("rejects an encoded event larger than the UTF-8 transport limit", () => {
    const oversized = {
      type: "search.completed",
      query: "oversized event",
      sources: Array.from({ length: 6 }, (_, index) => ({
        ...source,
        id: `source-${index}`,
        url: `https://example.com/${index}`,
        rawContent: "研".repeat(200_000),
      })),
      resultCount: 6,
    } as ResearchEvent;

    expect(() => encodeEvent(oversized)).toThrow(/event.*size/i);
  });

  it.each([
    ["plan.started", { type: "plan.started", question: 42 }],
    ["progress.updated", { type: "progress.updated", operationCount: 0, operationLimit: 1, searchRounds: 0 }],
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

  it.each(validEvents)("round-trips a valid $type event", (event) => {
    expect(decodeEventLine(encodeEvent(event))).toEqual(event);
  });

  it.each(["http://example.com/source", "https://example.com/source"])(
    "accepts an HTTP(S) source URL: %s",
    (url) => {
      expect(httpUrlSchema.parse(url)).toBe(url);
      expect(sourceSchema.parse({ ...source, url }).url).toBe(url);
      expect(researchEventSchema.parse({ type: "source.read", sourceId: source.id, url })).toEqual({
        type: "source.read",
        sourceId: source.id,
        url,
      });
    },
  );

  it.each(["javascript:alert(1)", "data:text/plain,secret", "file:///tmp/secret"])(
    "rejects a non-HTTP source URL: %s",
    (url) => {
      expect(() => httpUrlSchema.parse(url)).toThrow();
      expect(() => sourceSchema.parse({ ...source, url })).toThrow();
      expect(() => researchEventSchema.parse({ type: "source.read", sourceId: source.id, url })).toThrow();
    },
  );
});
