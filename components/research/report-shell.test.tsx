import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReportShell } from "./report-shell";

afterEach(cleanup);

describe("ReportShell", () => {
  it("composes the shared surface and phase class while forwarding article semantics", () => {
    render(
      <ReportShell
        phase="draft"
        className="streaming-report-draft"
        aria-label="Research report draft"
        aria-busy="true"
      >
        Draft body
      </ReportShell>,
    );

    const article = screen.getByRole("article", { name: "Research report draft" });
    expect(article).toHaveClass(
      "research-report",
      "report-shell-draft",
      "streaming-report-draft",
    );
    expect(article).toHaveAttribute("data-report-phase", "draft");
    expect(article).toHaveAttribute("aria-busy", "true");
  });
});
