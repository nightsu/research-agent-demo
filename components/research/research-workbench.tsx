"use client";

import { useMemo, useState } from "react";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchReport, Source, SourceEvaluation } from "@/lib/agent/research-types";

import { EventTimeline } from "./event-timeline";
import { ResearchForm } from "./research-form";
import { ResearchProgress } from "./research-progress";
import { ResearchReportView } from "./research-report";
import { SourceCard } from "./source-card";
import { useResearchStream } from "./use-research-stream";

export interface ResearchViewModel {
  sources: Source[];
  evaluations: Map<string, SourceEvaluation>;
  report?: ResearchReport;
}

export function deriveResearchViewModel(events: ResearchEvent[]): ResearchViewModel {
  const sources: Source[] = [];
  const sourceKeys = new Set<string>();
  const evaluations = new Map<string, SourceEvaluation>();
  let report: ResearchReport | undefined;

  for (const event of events) {
    if (event.type === "search.completed") {
      for (const source of event.sources) {
        if (sourceKeys.has(source.id) || sourceKeys.has(source.url)) continue;
        sourceKeys.add(source.id);
        sourceKeys.add(source.url);
        sources.push(source);
      }
    } else if (event.type === "source.evaluated") {
      evaluations.set(event.evaluation.sourceId, event.evaluation);
    } else if (event.type === "report.completed" || event.type === "research.partial") {
      report = event.report;
    }
  }

  return report ? { sources, evaluations, report } : { sources, evaluations };
}

export function ResearchWorkbench() {
  const { run, start, cancel, reset } = useResearchStream();
  const [selectedSource, setSelectedSource] = useState<string>();
  const view = useMemo(() => deriveResearchViewModel(run.events), [run.events]);
  const active = run.status === "running";
  const effectiveSelectedSource = view.sources.some(
    (source) => source.id === selectedSource,
  )
    ? selectedSource
    : undefined;

  if (run.status === "idle") {
    return (
      <main className="research-shell">
        <header className="hero">
          <p className="eyebrow">Observable research agent</p>
          <h1>See the evidence take shape.</h1>
          <p>
            Give the agent a focused question. Follow its plan, searches, source
            decisions, evidence gaps, and final cited report in one workspace.
          </p>
        </header>
        <ResearchForm disabled={false} onSubmit={start} />
        <section className="process-preview" aria-label="Research process">
          <span>01 · Plan</span><span>02 · Search</span><span>03 · Evaluate</span><span>04 · Synthesize</span>
        </section>
      </main>
    );
  }

  return (
    <main className="research-shell workspace-shell">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Research workspace</p>
          <h1>{active ? "Investigation in progress" : "Investigation record"}</h1>
        </div>
        {active ? (
          <button className="secondary-button stop-button" type="button" onClick={cancel}>
            Stop research
          </button>
        ) : (
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setSelectedSource(undefined);
              reset();
            }}
          >
            New research
          </button>
        )}
      </header>

      {run.error ? <div className="error-banner" role="alert">{run.error}</div> : null}

      <div className="workspace-grid">
        <ResearchProgress events={run.events} status={run.status} />
        <div className="workspace-content">
          <section
            className="timeline-section"
            aria-label="Research timeline"
            aria-live="polite"
            aria-busy={active}
          >
            <div className="section-heading">
              <div><p className="eyebrow">Event stream</p><h2>How the research unfolded</h2></div>
              <span className="event-count">{run.events.length} events</span>
            </div>
            <EventTimeline events={run.events} />
          </section>

          {view.report ? (
            <ResearchReportView
              report={view.report}
              sources={view.sources}
              onCitation={setSelectedSource}
            />
          ) : null}

          {view.sources.length > 0 ? (
            <section className="sources-section" aria-labelledby="sources-title">
              <div className="section-heading">
                <div><p className="eyebrow">Evidence library</p><h2 id="sources-title">Sources</h2></div>
              </div>
              <div className="source-grid">
                {view.sources.map((source, index) => (
                  <SourceCard
                    key={source.id}
                    source={source}
                    evaluation={view.evaluations.get(source.id)}
                    selected={effectiveSelectedSource === source.id}
                    citationNumber={index + 1}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
