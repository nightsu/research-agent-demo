"use client";

import { useEffect, useRef } from "react";

import type { Source, SourceEvaluation } from "@/lib/agent/research-types";

export function SourceDrawer({ source, evaluation, citationNumber, onClose }: {
  source?: Source;
  evaluation?: SourceEvaluation;
  citationNumber?: number;
  onClose(): void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!source) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button, a[href]")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // 抽屉关闭后恢复触发元素焦点，键盘用户才能从打开来源前的位置继续阅读。
      trigger?.focus();
    };
  }, [onClose, source]);

  if (!source) return null;
  return (
    <div className="source-drawer-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={panelRef} className="source-drawer" role="dialog" aria-modal="true" aria-labelledby="source-drawer-title">
        <div className="source-drawer-header">
          <span className="source-index">{citationNumber ? `[${citationNumber}]` : "Source"}</span>
          <button ref={closeRef} className="drawer-close" type="button" aria-label="Close source details" onClick={onClose}>×</button>
        </div>
        <p className="eyebrow">Evidence detail</p>
        <h2 id="source-drawer-title">{source.title}</h2>
        <p className="source-domain">{source.domain}{source.publishedAt ? ` · ${source.publishedAt}` : ""}</p>
        <p>{source.snippet}</p>
        {evaluation ? <section className="drawer-evaluation"><h3>{evaluation.decision}</h3><p>Relevance {evaluation.relevance}/5 · Authority {evaluation.authority}/5 · Freshness {evaluation.freshness}/5</p><p>{evaluation.reason}</p></section> : <p>Awaiting evaluation</p>}
        <a href={source.url} target="_blank" rel="noopener noreferrer">Open original source <span aria-hidden="true">↗</span><span className="visually-hidden"> (opens in a new tab)</span></a>
      </aside>
    </div>
  );
}
