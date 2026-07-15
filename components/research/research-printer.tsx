"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { PrinterRecord } from "./research-printer-model";

const BOTTOM_THRESHOLD_PX = 48;

export function ResearchPrinter({ records, onSourceSelect }: {
  records: PrinterRecord[];
  onSourceSelect(sourceId: string): void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [followingLatest, setFollowingLatest] = useState(true);

  const scrollToLatest = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    viewport?.scrollTo?.({ top: viewport.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => {
    if (followingLatest) scrollToLatest("smooth");
  }, [followingLatest, records.length, scrollToLatest]);

  return (
    <section className="printer-shell" aria-labelledby="printer-title">
      <header className="section-heading">
        <div><p className="eyebrow">Live record</p><h2 id="printer-title">How the research unfolded</h2></div>
        <span className="event-count">{records.length} records</span>
      </header>
      <div
        ref={viewportRef}
        className="printer-viewport"
        role="region"
        aria-label="Research process"
        onScroll={(event) => {
          const node = event.currentTarget;
          // 用户离开底部是在阅读历史；新事件不能强行夺走其滚动位置。
          setFollowingLatest(node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD_PX);
        }}
      >
        {records.length === 0 ? <p className="empty-note">Research records will appear here.</p> : (
          <ol className="printer-list">
            {records.map((record, index) => (
              <PrinterRecordView
                key={record.id}
                record={record}
                latest={index === records.length - 1}
                onSourceSelect={onSourceSelect}
              />
            ))}
          </ol>
        )}
      </div>
      {!followingLatest ? (
        <button className="latest-button" type="button" onClick={() => { setFollowingLatest(true); scrollToLatest("smooth"); }}>
          Back to latest progress
        </button>
      ) : null}
    </section>
  );
}

function PrinterRecordView({ record, latest, onSourceSelect }: {
  record: PrinterRecord;
  latest: boolean;
  onSourceSelect(sourceId: string): void;
}) {
  switch (record.kind) {
    case "plan":
      return <PrinterCard latest={latest} label={`Planning · ${record.status}`} title={record.plan?.objective ?? "Building the research plan"}>
        <p>{record.question}</p>
        {record.plan ? <details><summary>Plan details</summary><ul>{record.plan.subquestions.map((item) => <li key={item}>{item}</li>)}</ul></details> : null}
      </PrinterCard>;
    case "search":
      return <PrinterCard latest={latest} label={`Search · ${record.status}`} title={record.query}>
        <p>{record.reason}</p>
        {record.resultCount !== undefined ? <p className="event-meta">{record.resultCount} results · {record.sources.length} retained</p> : null}
        {record.sources.length ? <details><summary>{record.sources.length} retained sources</summary><ul className="printer-source-list">{record.sources.map((entry) => (
          <li key={entry.source.id}>
            <button type="button" onClick={() => onSourceSelect(entry.source.id)}>{entry.source.title}</button>
            <span>{entry.evaluation?.decision ?? (entry.read ? "read" : "queued")}</span>
          </li>
        ))}</ul></details> : null}
      </PrinterCard>;
    case "gap":
      return <PrinterCard latest={latest} label="Evidence gap · detected" title={record.description}><p>{record.followUpQueries.join(" · ")}</p></PrinterCard>;
    case "conclusion":
      return <PrinterCard latest={latest} label="Conclusion · updated" title={record.summary} />;
    case "synthesis":
      return <PrinterCard latest={latest} label={`Synthesis · ${record.status}`} title={record.partial ? "Preparing a partial report" : "Preparing the final report"} />;
    case "terminal":
      return <PrinterCard latest={latest} label={`Research · ${record.outcome}`} title={record.message} />;
  }
}

function PrinterCard({ label, title, latest, children }: { label: string; title: string; latest: boolean; children?: React.ReactNode }) {
  // 只标记最新事件，避免状态更新时旧记录也重新播放“走纸”动画。
  return <li className="printer-record" data-latest={latest}><article><p className="event-label">{label}</p><h3>{title}</h3>{children}</article></li>;
}
