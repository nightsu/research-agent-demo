import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReportDraftState } from "./use-research-stream";
import { StreamingReportDraft } from "./streaming-report-draft";

const tableDraft: ReportDraftState = {
  markdown: [
    "| Source | Confidence |",
    "| --- | --- |",
    "| Primary evidence | High |",
  ].join("\n"),
  sequence: 1,
  status: "streaming",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function verticalScrollOwners(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter((element) => {
    const utilityCreatesVerticalScroll = [
      "overflow-auto",
      "overflow-scroll",
      "overflow-y-auto",
      "overflow-y-scroll",
    ].some((className) => element.classList.contains(className));
    const inlineStyleCreatesVerticalScroll =
      /overflow(?:-y)?\s*:\s*(?:auto|scroll)/i.test(
        element.getAttribute("style") ?? "",
      );

    return utilityCreatesVerticalScroll || inlineStyleCreatesVerticalScroll;
  });
}

describe("StreamingReportDraft with real Streamdown", () => {
  it("keeps semantic streamed tables without creating a nested vertical scroll owner", () => {
    render(<StreamingReportDraft draft={tableDraft} />);
    const article = screen.getByRole("article");
    const table = within(article).getByRole("table");
    const tableRegion = within(article).getByRole("region", {
      name: "Scrollable report table",
    });

    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(tableRegion).toContainElement(table);
    expect(within(table).getByText("Source")).toBeInTheDocument();
    expect(within(table).getByText("Primary evidence")).toBeInTheDocument();
    expect(verticalScrollOwners(article)).toEqual([]);
  });

  it("keeps links inert, omits images, and does not interpret raw HTML", () => {
    render(
      <StreamingReportDraft
        draft={{
          ...tableDraft,
          markdown: [
            "[Unverified link](https://unsafe.example \"Collected context\")",
            "",
            "![Unverified image](https://unsafe.example/image.png)",
            "",
            "<strong>raw marker</strong>",
          ].join("\n"),
        }}
      />,
    );
    const article = screen.getByRole("article");
    const inertLink = within(article).getByText("Unverified link");
    const openSpy = vi.spyOn(window, "open");

    expect(inertLink.tagName).toBe("SPAN");
    expect(inertLink).toHaveClass("streaming-report-draft-link");
    expect(inertLink).toHaveAttribute("title", "Collected context");
    expect(inertLink).toHaveAttribute("aria-label", "Unverified link");
    expect(inertLink).not.toHaveAttribute("href");
    expect(inertLink).not.toHaveAttribute("tabindex");
    fireEvent.click(inertLink);
    expect(openSpy).not.toHaveBeenCalled();
    expect(article.querySelector("a")).not.toBeInTheDocument();
    expect(article.querySelector("img")).not.toBeInTheDocument();
    expect(article.querySelector("strong")).not.toBeInTheDocument();
    expect(article).toHaveTextContent("<strong>raw marker</strong>");
  });
});
