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
    a: (props: ComponentProps<"a">) => ReactNode;
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
  it("passes growing Markdown to Streamdown without live-announcing the body", () => {
    const { rerender } = render(<StreamingReportDraft draft={streamingDraft} />);
    const article = screen.getByRole("article");

    expect(article).toHaveClass("streaming-report-draft");
    expect(article).toHaveAttribute("aria-busy", "true");
    expect(article).not.toHaveAttribute("aria-live");
    expect(screen.getByRole("status")).toHaveTextContent("正在生成报告草稿");
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
  ] as const)("stops the caret while %s and announces only the status", (status, message) => {
    render(<StreamingReportDraft draft={{ ...streamingDraft, status }} />);

    expect(lastStreamdownProps().isAnimating).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.getByRole("article")).not.toHaveAttribute("aria-live");
  });

  it("marks an incomplete draft as idle and shows a clear warning", () => {
    render(<StreamingReportDraft draft={{ ...streamingDraft, status: "incomplete" }} />);

    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("status")).toHaveTextContent("报告草稿未完成");
    expect(lastStreamdownProps().isAnimating).toBe(false);
  });

  it("renders untrusted links as inert text and drops images", () => {
    render(<StreamingReportDraft draft={streamingDraft} />);
    const { a: DraftLink, img: DraftImage } = lastStreamdownProps().components;

    const { container } = render(
      <>
        {DraftLink({ href: "https://unsafe.example", children: "unverified link" })}
        {DraftImage({ src: "https://unsafe.example/image.png", alt: "unverified image" })}
      </>,
    );

    expect(screen.getByText("unverified link").tagName).toBe("SPAN");
    expect(screen.getByText("unverified link")).not.toHaveAttribute("href");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });
});
