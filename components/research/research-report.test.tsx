import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResearchReport, Source } from "@/lib/agent/research-types";

import { ResearchReportView } from "./research-report";

const source: Source = {
  id: "source-1",
  title: "Primary evidence",
  url: "https://example.com/evidence",
  domain: "example.com",
  snippet: "Direct evidence",
};

const report: ResearchReport = {
  title: "A complete report",
  executiveSummary: [
    `[Known source](${source.url}#section)`,
    "[Unknown source](https://unsafe.example/path)",
  ].join(" "),
  findings: [
    {
      claim: "The evidence supports the finding.",
      sourceIds: [source.id, "missing-source"],
      confidence: "high",
    },
  ],
  trends: ["Adoption is increasing."],
  disagreements: ["Timing differs."],
  limitations: ["Public evidence only."],
};

afterEach(cleanup);

describe("ResearchReportView", () => {
  it.each([
    { animate: undefined, marker: "true" },
    { animate: true, marker: "true" },
    { animate: false, marker: "false" },
  ])("sets data-animate=$marker when animate is $animate", ({ animate, marker }) => {
    const { container } = render(
      <ResearchReportView
        report={report}
        sources={[source]}
        animate={animate}
        onCitation={vi.fn()}
      />,
    );

    const article = container.querySelector(".research-report");
    expect(article).toHaveClass("report-shell-final");
    expect(article).toHaveAttribute("data-report-phase", "final");
    expect(article).toHaveAttribute("data-animate", marker);
  });

  it("keeps known citations interactive and unknown model links inert", () => {
    const onCitation = vi.fn();
    render(
      <ResearchReportView
        report={report}
        sources={[source]}
        onCitation={onCitation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /view source 1/i }));
    expect(onCitation).toHaveBeenCalledWith(source.id);
    expect(screen.getByText(/citation unavailable/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /known source.*new tab/i })).toHaveAttribute(
      "href",
      source.url,
    );
    expect(screen.queryByRole("link", { name: /unknown source/i })).not.toBeInTheDocument();
    expect(screen.getByText("Unknown source", { selector: "span" }).tagName).toBe("SPAN");
  });
});
