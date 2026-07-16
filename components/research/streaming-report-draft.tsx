"use client";

import type { ComponentPropsWithoutRef } from "react";
import {
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";

import { ReportShell } from "./report-shell";
import type { ReportDraftState } from "./use-research-stream";

export interface StreamingReportDraftProps {
  draft: ReportDraftState;
}

const draftStatusText: Record<ReportDraftState["status"], string> = {
  streaming: "正在生成报告草稿",
  validating: "正在校验报告草稿",
  repairing: "正在修复报告草稿",
  incomplete: "报告草稿未完成，最终报告尚不可用",
};

type DraftLinkProps = ComponentPropsWithoutRef<"a"> & ExtraProps;
type DraftTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;

function DraftTable({ node, ...tableProps }: DraftTableProps) {
  // node 是 Markdown AST 元数据，不能透传给真实 DOM 元素。
  void node;
  return (
    <div
      className="streaming-report-draft-table"
      role="region"
      aria-label="Scrollable report table"
      tabIndex={0}
    >
      <table {...tableProps} data-streamdown="draft-table" />
    </div>
  );
}

function DraftLink({
  children,
  title,
  className,
  lang,
  dir,
  "aria-label": ariaLabel,
  href,
  node,
  target,
  rel,
  download,
}: DraftLinkProps) {
  // 草稿链接只保留非交互元数据；目标地址、AST 元数据和所有未列出的事件处理器都被丢弃。
  void href;
  void node;
  void target;
  void rel;
  void download;
  return (
    <span
      className={["streaming-report-draft-link", className]
        .filter(Boolean)
        .join(" ")}
      title={title}
      lang={lang}
      dir={dir}
      aria-label={
        ariaLabel ?? (typeof children === "string" ? children : undefined)
      }
    >
      {children}
    </span>
  );
}

const draftMarkdownComponents = {
  a: DraftLink,
  img: () => null,
  table: DraftTable,
} satisfies Pick<Components, "a" | "img" | "table">;
// Streamdown 2.5 的 Components 索引签名比具体元素属性更宽；上方 Pick 已逐项校验实现。
const streamdownDraftComponents = draftMarkdownComponents as Components;

// 不启用 Streamdown 的 raw HTML 处理链；HTML 片段只会作为普通草稿文本出现。
const draftRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [];

export function StreamingReportDraft({ draft }: StreamingReportDraftProps) {
  const isStreaming = draft.status === "streaming";
  // 校验和修复仍属于处理中；只有 incomplete 才是停止工作的草稿。
  const isBusy = draft.status !== "incomplete";

  return (
    <ReportShell
      phase="draft"
      className="streaming-report-draft"
      aria-label="Research report draft"
      aria-busy={isBusy}
    >
      {/* 正式稿和草稿共享同一元信息起点，完成替换时不会像换了一张纸。 */}
      <div className="report-meta">
        <p className="eyebrow">Research report</p>
        <p className={`draft-status draft-status-${draft.status}`}>
          {draftStatusText[draft.status]}
        </p>
      </div>
      <Streamdown
        className="streaming-report-draft-body"
        mode="streaming"
        isAnimating={isStreaming}
        caret="block"
        controls={false}
        skipHtml
        rehypePlugins={draftRehypePlugins}
        components={streamdownDraftComponents}
      >
        {draft.markdown}
      </Streamdown>
    </ReportShell>
  );
}
