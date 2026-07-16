import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

afterEach(() => cleanup());

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
            "[Unverified link](https://unsafe.example)",
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

    expect(inertLink.tagName).toBe("SPAN");
    expect(article.querySelector("a")).not.toBeInTheDocument();
    expect(article.querySelector("img")).not.toBeInTheDocument();
    expect(article.querySelector("strong")).not.toBeInTheDocument();
    expect(article).toHaveTextContent("<strong>raw marker</strong>");
  });
});
