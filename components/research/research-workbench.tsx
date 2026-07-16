"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ResearchForm } from "./research-form";
import { derivePrinterRecords } from "./research-printer-model";
import { ResearchPrinter } from "./research-printer";
import { ResearchProgress } from "./research-progress";
import { ResearchReportView } from "./research-report";
import { deriveResearchViewModel, runStatusLabel } from "./research-view-model";
import { SourceDrawer } from "./source-drawer";
import { StreamingReportDraft } from "./streaming-report-draft";
import { useResearchStream, type ResearchRunStatus } from "./use-research-stream";

const BOTTOM_THRESHOLD_PX = 48;

export function ResearchWorkbench() {
  const { run, start, retry, canRetry, cancel, reset } = useResearchStream();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const view = useMemo(() => deriveResearchViewModel(run.events), [run.events]);
  const records = useMemo(() => derivePrinterRecords(run.events), [run.events]);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const workspaceDocumentRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef<ResearchRunStatus>(run.status);
  const previousReportSurface = useRef(false);
  const previousEventCount = useRef(run.events.length);
  const previousDraftSequence = useRef(run.reportDraft?.sequence);
  const previousDraftLength = useRef(run.reportDraft?.markdown.length);
  const draftGrowthAwaitingResize = useRef(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const followingLatestRef = useRef(followingLatest);
  const reportDraftRef = useRef(run.reportDraft);
  const active = run.status === "running";
  const reportSurface = run.reportDraft !== undefined || view.report !== undefined;
  const selectedIdentity = selectedSourceId ? (view.sourceIdentityById.get(selectedSourceId) ?? selectedSourceId) : undefined;
  const selectedSource = view.sources.find((source) => source.id === selectedIdentity);
  const scrollWorkspace = useCallback((top: number) => {
    workspaceRef.current?.scrollTo?.({ top, behavior: "auto" });
  }, []);
  const updateFollowingFromScrollPosition = useCallback((viewport = workspaceRef.current) => {
    if (!viewport) return;
    setFollowingLatest(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX,
    );
  }, []);
  const resumeFollowing = useCallback(() => {
    setFollowingLatest(true);
    const viewport = workspaceRef.current;
    if (viewport) scrollWorkspace(viewport.scrollHeight);
  }, [scrollWorkspace]);

  useLayoutEffect(() => {
    followingLatestRef.current = followingLatest;
    reportDraftRef.current = run.reportDraft;
  }, [followingLatest, run.reportDraft]);

  useLayoutEffect(() => {
    const enteredReportSurface = reportSurface && !previousReportSurface.current;
    const draftGrew = run.reportDraft !== undefined && (
      (previousDraftSequence.current !== undefined && run.reportDraft.sequence > previousDraftSequence.current) ||
      (previousDraftLength.current !== undefined && run.reportDraft.markdown.length > previousDraftLength.current)
    );
    const processGrew = !reportSurface && run.events.length > previousEventCount.current;

    if (enteredReportSurface) {
      // 报告从 started 起就是主阅读面；每代研究只在首次进入时定位顶部。
      scrollWorkspace(0);
    } else if (followingLatest && (draftGrew || processGrew)) {
      // 跟随仅负责展示位置，不能参与事件消费或业务阶段推进。
      const viewport = workspaceRef.current;
      if (viewport) scrollWorkspace(viewport.scrollHeight);
    }

    draftGrowthAwaitingResize.current = draftGrew && followingLatest;
    previousReportSurface.current = reportSurface;
    previousEventCount.current = run.events.length;
    previousDraftSequence.current = run.reportDraft?.sequence;
    previousDraftLength.current = run.reportDraft?.markdown.length;
  }, [followingLatest, reportSurface, run.events.length, run.reportDraft, scrollWorkspace]);

  useEffect(() => {
    const workspaceDocument = workspaceDocumentRef.current;
    if (!workspaceDocument || typeof ResizeObserver === "undefined") return;

    // 展开 details 会改变文档高度，却不会触发滚动事件；观察文档流才能及时暂停错误的“跟随最新”。
    const observer = new ResizeObserver(() => {
      const viewport = workspaceRef.current;
      if (
        viewport &&
        reportDraftRef.current &&
        followingLatestRef.current &&
        draftGrowthAwaitingResize.current
      ) {
        // Markdown 排版后的真实高度可能晚于提交变化；仍由右侧唯一滚动容器跟到底部。
        scrollWorkspace(viewport.scrollHeight);
        draftGrowthAwaitingResize.current = false;
        return;
      }
      updateFollowingFromScrollPosition();
    });
    observer.observe(workspaceDocument);
    return () => observer.disconnect();
  }, [run.status, scrollWorkspace, updateFollowingFromScrollPosition]);

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
            onScroll={(event) => updateFollowingFromScrollPosition(event.currentTarget)}
          >
            <div ref={workspaceDocumentRef}>
              {reportSurface ? (
                <>
                  {run.reportDraft ? (
                    <StreamingReportDraft draft={run.reportDraft} />
                  ) : view.report ? (
                    <ResearchReportView
                      report={view.report}
                      sources={view.sources}
                      citationNumbers={view.citationNumbers}
                      animate={!run.hadReportDraft}
                      onCitation={setSelectedSourceId}
                    />
                  ) : null}
                  {/* 报告草稿与正式报告原位替换；完成只换内容，不重置读者位置。 */}
                  <details className="process-archive"><summary>View research process</summary>{printer}</details>
                </>
              ) : printer}
            </div>
          </div>
          {!followingLatest ? (
            <button className="latest-button" type="button" onClick={resumeFollowing}>
              {reportSurface ? "Back to latest report" : "Back to latest progress"}
            </button>
          ) : null}
        </div>
      </div>
      <SourceDrawer source={selectedSource} evaluation={selectedIdentity ? view.evaluations.get(selectedIdentity) : undefined} citationNumber={selectedIdentity ? view.citationNumbers.get(selectedIdentity) : undefined} onClose={() => setSelectedSourceId(undefined)} />
    </main>
  );
}
