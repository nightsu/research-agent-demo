"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EventTimeline } from "./event-timeline";
import { ResearchForm } from "./research-form";
import { ResearchProgress } from "./research-progress";
import { ResearchReportView } from "./research-report";
import {
  deriveResearchViewModel,
  runStatusLabel,
  sourceDomId,
} from "./research-view-model";
import { SourceCard } from "./source-card";
import { useResearchStream, type ResearchRunStatus } from "./use-research-stream";

export function ResearchWorkbench() {
  const { run, start, cancel, reset } = useResearchStream();
  const [selectedSource, setSelectedSource] = useState<string>();
  const view = useMemo(
    () => deriveResearchViewModel(run.events),
    [run.events],
  );
  const statusRef = useRef<HTMLParagraphElement>(null);
  const previousStatus = useRef<ResearchRunStatus>(run.status);
  const active = run.status === "running";
  const effectiveSelectedSource = view.sources.some(
    (source) => source.id === selectedSource,
  )
    ? selectedSource
    : undefined;

  useEffect(() => {
    if (previousStatus.current === "running" && run.status === "cancelled") {
      statusRef.current?.focus();
    }
    previousStatus.current = run.status;
  }, [run.status]);

  const navigateToCitation = useCallback(
    (sourceId: string) => {
      const identity = view.sourceIdentityById.get(sourceId) ?? sourceId;
      setSelectedSource(identity);
      const target = document.getElementById(sourceDomId(identity));
      const reducedMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches ?? false;
      target?.scrollIntoView?.({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "center",
      });
      target?.focus({ preventScroll: true });
    },
    [view.sourceIdentityById],
  );

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

      <p
        ref={statusRef}
        className="run-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        tabIndex={-1}
      >
        {runStatusLabel[run.status]}. Latest event: {view.latestEventLabel}.
      </p>

      <div className="workspace-grid">
        <ResearchProgress viewModel={view} status={run.status} />
        <div className="workspace-content">
          <section
            className="timeline-section"
            aria-label="Research timeline"
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
              citationNumbers={view.citationNumbers}
              onCitation={navigateToCitation}
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
