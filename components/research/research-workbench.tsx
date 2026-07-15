"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ResearchForm } from "./research-form";
import { derivePrinterRecords } from "./research-printer-model";
import { ResearchPrinter } from "./research-printer";
import { ResearchProgress } from "./research-progress";
import { ResearchReportView } from "./research-report";
import { deriveResearchViewModel, runStatusLabel } from "./research-view-model";
import { SourceDrawer } from "./source-drawer";
import { useResearchStream, type ResearchRunStatus } from "./use-research-stream";

const BOTTOM_THRESHOLD_PX = 48;

export function ResearchWorkbench() {
  const { run, start, retry, canRetry, cancel, reset } = useResearchStream();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const view = useMemo(() => deriveResearchViewModel(run.events), [run.events]);
  const records = useMemo(() => derivePrinterRecords(run.events), [run.events]);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef<ResearchRunStatus>(run.status);
  const previousReportFirst = useRef(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const active = run.status === "running";
  const reportFirst = run.status === "completed" || run.status === "partial";
  const selectedIdentity = selectedSourceId ? (view.sourceIdentityById.get(selectedSourceId) ?? selectedSourceId) : undefined;
  const selectedSource = view.sources.find((source) => source.id === selectedIdentity);
  const scrollWorkspace = useCallback((top: number) => {
    workspaceRef.current?.scrollTo?.({ top, behavior: "auto" });
  }, []);

  useLayoutEffect(() => {
    const enteredReport = reportFirst && !previousReportFirst.current;
    if (enteredReport) {
      // 完成态会把报告重排到过程记录之前；只在首次进入时把报告标题带回视野。
      scrollWorkspace(0);
    } else if (active && followingLatest) {
      // 跟随仅负责展示位置，不能参与事件消费或业务阶段推进。
      const viewport = workspaceRef.current;
      if (viewport) scrollWorkspace(viewport.scrollHeight);
    }
    previousReportFirst.current = reportFirst;
  }, [active, followingLatest, reportFirst, run.events.length, scrollWorkspace]);

  useEffect(() => {
    if (previousStatus.current === "running" && run.status === "cancelled") statusRef.current?.focus();
    previousStatus.current = run.status;
  }, [run.status]);

  if (run.status === "idle") {
    return <main className="research-shell"><header className="hero"><p className="eyebrow">Observable research agent</p><h1>See the evidence take shape.</h1><p>Give the agent a focused question. Follow its plan, searches, source decisions, evidence gaps, and final cited report in one workspace.</p></header><ResearchForm disabled={false} onSubmit={(request) => { setFollowingLatest(true); start(request); }} /><section className="process-preview" aria-label="Research process"><span>01 · Plan</span><span>02 · Search</span><span>03 · Evaluate</span><span>04 · Synthesize</span></section></main>;
  }

  const printer = <ResearchPrinter records={records} onSourceSelect={setSelectedSourceId} />;
  return (
    <main className="research-shell workspace-shell">
      <header className="workspace-header">
        <div><p className="eyebrow">Research workspace</p><h1>{active ? "Investigation in progress" : "Investigation record"}</h1></div>
        <div className="workspace-actions">
          {active ? <button className="secondary-button stop-button" type="button" onClick={cancel}>Stop research</button> : null}
          {!active && canRetry ? <button className="secondary-button" type="button" onClick={() => { setFollowingLatest(true); void retry(); }}>Retry research</button> : null}
          {!active ? <button className="secondary-button" type="button" onClick={() => { setFollowingLatest(true); setSelectedSourceId(undefined); reset(); }}>New research</button> : null}
        </div>
      </header>
      {run.error ? <div className="error-banner" role="alert">{run.error}</div> : null}
      <p ref={statusRef} className="run-status" role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>{runStatusLabel[run.status]}. Latest event: {view.latestEventLabel}.</p>
      <div className="workspace-grid">
        <ResearchProgress viewModel={view} status={run.status} />
        <div className="workspace-content-shell">
          <div
            ref={workspaceRef}
            className="workspace-content"
            role="region"
            aria-label="Research workspace content"
            onScroll={(event) => {
              const node = event.currentTarget;
              setFollowingLatest(node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD_PX);
            }}
          >
            {reportFirst && view.report ? (
              <>
                <ResearchReportView report={view.report} sources={view.sources} citationNumbers={view.citationNumbers} onCitation={setSelectedSourceId} />
                {/* 完成态优先阅读结论，失败态优先诊断过程，所以只有前者自动折叠打印记录。 */}
                <details className="process-archive"><summary>View research process</summary>{printer}</details>
              </>
            ) : printer}
          </div>
          {!reportFirst && !followingLatest ? (
            <button className="latest-button" type="button" onClick={() => setFollowingLatest(true)}>
              Back to latest progress
            </button>
          ) : null}
        </div>
      </div>
      <SourceDrawer source={selectedSource} evaluation={selectedIdentity ? view.evaluations.get(selectedIdentity) : undefined} citationNumber={selectedIdentity ? view.citationNumbers.get(selectedIdentity) : undefined} onClose={() => setSelectedSourceId(undefined)} />
    </main>
  );
}
