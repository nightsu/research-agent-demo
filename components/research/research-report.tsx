import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ResearchReport, Source } from "@/lib/agent/research-types";
import { canonicalizeUrl } from "@/lib/agent/research-state";
import { buildCitationNumbers } from "./research-view-model";

export interface ResearchReportViewProps {
  report: ResearchReport;
  sources: Source[];
  citationNumbers?: Map<string, number>;
  onCitation(sourceId: string): void;
}

export function ResearchReportView({ report, sources, citationNumbers = buildCitationNumbers(sources), onCitation }: ResearchReportViewProps) {
  const sourceUrlByCanonicalUrl = new Map(
    sources.map((source) => [canonicalizeUrl(source.url), source.url]),
  );
  const markdownComponents = createMarkdownComponents(sourceUrlByCanonicalUrl);

  return (
    <article className="research-report" aria-labelledby="report-title">
      <p className="eyebrow">Research report</p>
      <h2 id="report-title">{report.title}</h2>
      <section>
        <h3>Executive summary</h3>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {report.executiveSummary}
        </ReactMarkdown>
      </section>
      <section>
        <h3>Key findings</h3>
        <div className="findings-list">
          {report.findings.map((finding, index) => (
            <article className="finding" key={`${finding.claim}-${index}`}>
              <span className={`confidence confidence-${finding.confidence}`}>
                {finding.confidence} confidence
              </span>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {finding.claim}
              </ReactMarkdown>
              <div className="citations" aria-label="Finding sources">
                {finding.sourceIds.map((sourceId) => {
                  const citationNumber = citationNumbers.get(sourceId);
                  return citationNumber ? (
                    <button
                      key={sourceId}
                      type="button"
                      aria-label={`View source ${citationNumber}`}
                      onClick={() => onCitation(sourceId)}
                    >
                      [{citationNumber}]
                    </button>
                  ) : (
                    <span className="missing-citation" key={sourceId}>Citation unavailable</span>
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      </section>
      <ReportList title="Trends" items={report.trends} components={markdownComponents} />
      <ReportList title="Disagreements" items={report.disagreements} components={markdownComponents} />
      <ReportList title="Limitations" items={report.limitations} components={markdownComponents} />
    </article>
  );
}

function ReportList({ title, items, components }: { title: string; items: string[]; components: ReturnType<typeof createMarkdownComponents> }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul>{items.map((item) => <li key={item}><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{item}</ReactMarkdown></li>)}</ul>
    </section>
  );
}

function createMarkdownComponents(sourceUrlByCanonicalUrl: ReadonlyMap<string, string>) {
  return {
    a: ({ href, children }: React.ComponentPropsWithoutRef<"a">) => {
      let allowedHref: string | undefined;
      try {
        if (href) allowedHref = sourceUrlByCanonicalUrl.get(canonicalizeUrl(href));
      } catch {
        // Invalid and non-HTTP model-generated links are deliberately inert.
      }
      return allowedHref ? (
        <a href={allowedHref} target="_blank" rel="noopener noreferrer">
          {children}<span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      ) : (
        <span>{children}<span className="visually-hidden"> (link unavailable: not a collected source)</span></span>
      );
    },
  };
}
