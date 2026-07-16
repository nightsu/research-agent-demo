import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReportDraftState } from "./use-research-stream";

interface StreamdownProps {
  children: ReactNode;
  mode: string;
  isAnimating: boolean;
  caret: string;
  controls: boolean;
  skipHtml: boolean;
  components: {
    a: (props: ComponentProps<"a"> & { node?: unknown }) => ReactNode;
    img: (props: ComponentProps<"img">) => ReactNode;
  };
}

const streamdownSpy = vi.hoisted(() => vi.fn());

vi.mock("streamdown", () => ({
  Streamdown: (props: StreamdownProps) => {
    streamdownSpy(props);
    return <div data-testid="streamdown-output">{props.children}</div>;
  },
}));

import { StreamingReportDraft } from "./streaming-report-draft";

const streamingDraft: ReportDraftState = {
  markdown: "# First finding",
  sequence: 1,
  status: "streaming",
};

afterEach(() => cleanup());

function lastStreamdownProps() {
  return streamdownSpy.mock.lastCall?.[0] as StreamdownProps;
}

describe("StreamingReportDraft", () => {
  it("passes growing Markdown to Streamdown without creating a local live region", () => {
    const { rerender } = render(<StreamingReportDraft draft={streamingDraft} />);
    const article = screen.getByRole("article");

    expect(article).toHaveClass("streaming-report-draft");
    expect(article).toHaveAttribute("aria-busy", "true");
    expect(article).not.toHaveAttribute("aria-live");
    expect(screen.getByText("正在生成报告草稿")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(article.querySelector("[aria-live]")).not.toBeInTheDocument();
    expect(lastStreamdownProps()).toMatchObject({
      children: "# First finding",
      mode: "streaming",
      isAnimating: true,
      caret: "block",
      controls: false,
      skipHtml: true,
    });

    rerender(
      <StreamingReportDraft
        draft={{ ...streamingDraft, markdown: "# First finding\n\nMore evidence.", sequence: 2 }}
      />,
    );

    expect(lastStreamdownProps().children).toBe("# First finding\n\nMore evidence.");
  });

  it.each([
    ["validating", "正在校验报告草稿"],
    ["repairing", "正在修复报告草稿"],
  ] as const)("stops the caret while %s and leaves status announcement to the Workbench", (status, message) => {
    render(<StreamingReportDraft draft={{ ...streamingDraft, status }} />);

    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "true");
    expect(lastStreamdownProps().isAnimating).toBe(false);
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("article").querySelector("[aria-live]")).not.toBeInTheDocument();
  });

  it("marks an incomplete draft as idle and shows a clear warning", () => {
    render(<StreamingReportDraft draft={{ ...streamingDraft, status: "incomplete" }} />);

    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText(/报告草稿未完成/)).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(lastStreamdownProps().isAnimating).toBe(false);
  });

  it("renders untrusted links as inert text and drops images", () => {
    render(<StreamingReportDraft draft={streamingDraft} />);
    const { a: DraftLink, img: DraftImage } = lastStreamdownProps().components;
    const onClick = vi.fn();

    const { container } = render(
      <>
        {DraftLink({
          href: "https://unsafe.example",
          target: "_blank",
          rel: "opener",
          download: "unsafe.txt",
          onClick,
          title: "Collected context",
          className: "model-link",
          lang: "en",
          dir: "ltr",
          "aria-label": "Unverified evidence link",
          node: { type: "element" },
          children: "unverified link",
        })}
        {DraftImage({ src: "https://unsafe.example/image.png", alt: "unverified image" })}
      </>,
    );

    const inertLink = screen.getByText("unverified link");
    expect(inertLink.tagName).toBe("SPAN");
    expect(inertLink).toHaveClass("streaming-report-draft-link", "model-link");
    expect(inertLink).toHaveAttribute("title", "Collected context");
    expect(inertLink).toHaveAttribute("lang", "en");
    expect(inertLink).toHaveAttribute("dir", "ltr");
    expect(inertLink).toHaveAttribute("aria-label", "Unverified evidence link");
    expect(inertLink).not.toHaveAttribute("href");
    expect(inertLink).not.toHaveAttribute("target");
    expect(inertLink).not.toHaveAttribute("rel");
    expect(inertLink).not.toHaveAttribute("download");
    expect(inertLink).not.toHaveAttribute("tabindex");
    inertLink.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });
});
