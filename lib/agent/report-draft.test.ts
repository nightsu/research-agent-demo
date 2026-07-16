import { describe, expect, it } from "vitest";

import {
  createReportDraftUpdate,
  reportDraftToMarkdown,
  type PartialResearchReport,
} from "./report-draft";

describe("report draft projection", () => {
  it("renders only present fields in a deterministic order with mapped citations", () => {
    const partial: PartialResearchReport = {
      limitations: ["Coverage is limited."],
      findings: [
        {
          claim: "Official docs describe tool-assisted research.",
          sourceIds: ["unknown-source", "source-2"],
          confidence: "high",
        },
        { claim: "A finding can arrive before its citations." },
      ],
      title: "Research agents",
      disagreements: ["Sources disagree about pricing."],
      executiveSummary: "Research agents combine search and synthesis.",
      trends: ["Long-running workflows are becoming observable."],
    };
    const citationMap = new Map([
      ["source-1", 1],
      ["source-2", 2],
    ]);

    expect(reportDraftToMarkdown(partial, citationMap)).toBe([
      "# Research agents",
      "",
      "## Executive summary",
      "",
      "Research agents combine search and synthesis.",
      "",
      "## Key findings",
      "",
      "- Official docs describe tool-assisted research. (confidence: high) [2]",
      "- A finding can arrive before its citations.",
      "",
      "## Trends",
      "",
      "- Long-running workflows are becoming observable.",
      "",
      "## Disagreements",
      "",
      "- Sources disagree about pricing.",
      "",
      "## Limitations",
      "",
      "- Coverage is limited.",
    ].join("\n"));
  });

  it("omits sections whose fields have not arrived", () => {
    expect(reportDraftToMarkdown({ title: "Research agents" }, new Map())).toBe(
      "# Research agents",
    );
  });

  it("safely projects deeply partial arrays and nested finding fields", () => {
    const partial: PartialResearchReport = {
      findings: [
        undefined,
        {
          claim: "The draft can contain sparse nested values.",
          confidence: "medium",
          sourceIds: [undefined, "source-1"],
        },
      ],
      trends: [undefined, "Observable workflows are becoming common."],
      disagreements: [undefined],
      limitations: [undefined],
    };

    expect(reportDraftToMarkdown(partial, new Map([["source-1", 1]]))).toBe([
      "## Key findings",
      "",
      "- The draft can contain sparse nested values. (confidence: medium) [1]",
      "",
      "## Trends",
      "",
      "- Observable workflows are becoming common.",
    ].join("\n"));
  });
});

describe("report draft updates", () => {
  it("appends only the new suffix when the draft grows", () => {
    expect(createReportDraftUpdate("# Title", "# Title\n\nMore")).toEqual({
      mode: "append",
      text: "\n\nMore",
    });
  });

  it("replaces the complete snapshot when earlier content changes", () => {
    expect(createReportDraftUpdate("# Old", "# Revised")).toEqual({
      mode: "replace",
      text: "# Revised",
    });
  });

  it("does not emit an update for an identical snapshot", () => {
    expect(createReportDraftUpdate("# Title", "# Title")).toBeUndefined();
  });
});
