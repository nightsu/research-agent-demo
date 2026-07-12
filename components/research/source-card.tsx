"use client";

import { useEffect, useRef } from "react";

import type { Source, SourceEvaluation } from "@/lib/agent/research-types";

export interface SourceCardProps {
  source: Source;
  evaluation?: SourceEvaluation;
  selected: boolean;
  citationNumber?: number;
}

export function SourceCard({
  source,
  evaluation,
  selected,
  citationNumber,
}: SourceCardProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    ref.current?.focus({ preventScroll: true });
  }, [selected]);

  return (
    <article
      ref={ref}
      id={`source-${source.id}`}
      className="source-card"
      aria-label={source.title}
      data-selected={selected ? "true" : "false"}
      tabIndex={-1}
    >
      <div className="source-card-header">
        <span className="source-index">{citationNumber ? `[${citationNumber}]` : "Source"}</span>
        <span className={`status-badge status-${evaluation?.decision ?? "unreviewed"}`}>
          {evaluation?.decision === "accepted"
            ? "Accepted"
            : evaluation?.decision === "rejected"
              ? "Rejected"
              : "Awaiting evaluation"}
        </span>
      </div>
      <h3>{source.title}</h3>
      <p className="source-domain">{source.domain}{source.publishedAt ? ` · ${source.publishedAt}` : ""}</p>
      <p className="source-snippet">{source.snippet.slice(0, 420)}</p>
      {evaluation ? <p className="source-reason">{evaluation.reason}</p> : null}
      <a href={source.url} target="_blank" rel="noopener noreferrer">
        Open source <span aria-hidden="true">↗</span>
      </a>
    </article>
  );
}
