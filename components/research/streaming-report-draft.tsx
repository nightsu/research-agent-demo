"use client";

import type { ComponentPropsWithoutRef } from "react";
import {
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";

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

const draftMarkdownComponents = {
  a: ({ children }: DraftLinkProps) => (
    <span className="streaming-report-draft-link">{children}</span>
  ),
  img: () => null,
} satisfies Pick<Components, "a" | "img">;
// Streamdown 2.5 的 Components 索引签名比具体元素属性更宽；上方 Pick 已逐项校验实现。
const streamdownDraftComponents = draftMarkdownComponents as Components;

// 不启用 Streamdown 的 raw HTML 处理链；HTML 片段只会作为普通草稿文本出现。
const draftRehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [];

export function StreamingReportDraft({ draft }: StreamingReportDraftProps) {
  const isStreaming = draft.status === "streaming";

  return (
    <article className="streaming-report-draft" aria-busy={isStreaming}>
      {/* 正文会逐 token 更新，刻意不使用 aria-live，避免读屏器持续刷屏；只播报低频状态。 */}
      <p
        className={`draft-status draft-status-${draft.status}`}
        role="status"
        aria-live="polite"
      >
        {draftStatusText[draft.status]}
      </p>
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
    </article>
  );
}
