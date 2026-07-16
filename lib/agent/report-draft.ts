import type { DeepPartial } from "ai";

import type { ResearchReport } from "./research-types";

export type PartialResearchReport = DeepPartial<ResearchReport>;

export type ReportDraftUpdate = {
  mode: "append" | "replace";
  text: string;
};

type CitationMap = ReadonlyMap<string, number>;

function renderListSection(
  heading: string,
  items: ReadonlyArray<string | undefined> | undefined,
): string | undefined {
  const renderedItems = items?.filter((item): item is string => Boolean(item?.trim()));
  if (!renderedItems?.length) {
    return undefined;
  }

  return [`## ${heading}`, "", ...renderedItems.map((item) => `- ${item}`)].join("\n");
}

export function reportDraftToMarkdown(
  partial: PartialResearchReport,
  citationMap: CitationMap,
): string {
  const sections: Array<string | undefined> = [];

  if (partial.title?.trim()) {
    sections.push(`# ${partial.title}`);
  }

  if (partial.executiveSummary?.trim()) {
    sections.push(`## Executive summary\n\n${partial.executiveSummary}`);
  }

  const findings = partial.findings
    // AI SDK 的 DeepPartial 会在数组槽位和对象字段尚未生成时放入 undefined，投影边界必须逐层收窄。
    ?.filter((finding): finding is NonNullable<typeof finding> & { claim: string } => (
      Boolean(finding?.claim?.trim())
    ))
    .map((finding) => {
      const citations = finding.sourceIds
        ?.flatMap((sourceId) => {
          if (sourceId === undefined) {
            return [];
          }
          const citation = citationMap.get(sourceId);
          return citation === undefined ? [] : [`[${citation}]`];
        })
        .join(" ");
      const confidence = finding.confidence
        ? ` (confidence: ${finding.confidence})`
        : "";

      return `${finding.claim}${confidence}${citations ? ` ${citations}` : ""}`;
    });

  sections.push(renderListSection("Key findings", findings));
  sections.push(renderListSection("Trends", partial.trends));
  sections.push(renderListSection("Disagreements", partial.disagreements));
  sections.push(renderListSection("Limitations", partial.limitations));

  return sections.filter((section): section is string => section !== undefined).join("\n\n");
}

export function createReportDraftUpdate(
  previous: string,
  current: string,
): ReportDraftUpdate | undefined {
  if (previous === current) {
    return undefined;
  }

  // structured partial 通常会持续增长，但协议并不保证只追加；模型修订前文时必须发送完整快照。
  if (current.startsWith(previous)) {
    return { mode: "append", text: current.slice(previous.length) };
  }

  return { mode: "replace", text: current };
}
