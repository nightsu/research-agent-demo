import type { ResearchReport } from "./research-types";

export type PartialResearchReport = {
  [Key in keyof ResearchReport]?: Key extends "findings"
    ? Array<Partial<ResearchReport["findings"][number]>>
    : ResearchReport[Key];
};

export type ReportDraftUpdate = {
  mode: "append" | "replace";
  text: string;
};

type CitationMap = ReadonlyMap<string, number>;

function renderListSection(heading: string, items: string[] | undefined): string | undefined {
  const renderedItems = items?.filter((item) => item.length > 0);
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

  if (partial.title) {
    sections.push(`# ${partial.title}`);
  }

  if (partial.executiveSummary) {
    sections.push(`## Executive summary\n\n${partial.executiveSummary}`);
  }

  const findings = partial.findings
    ?.filter((finding): finding is typeof finding & { claim: string } => Boolean(finding.claim))
    .map((finding) => {
      const citations = finding.sourceIds
        ?.flatMap((sourceId) => {
          const citation = citationMap.get(sourceId);
          return citation === undefined ? [] : [`[${citation}]`];
        })
        .join(" ");

      return citations ? `${finding.claim} ${citations}` : finding.claim;
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
