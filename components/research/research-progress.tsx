import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchRunStatus } from "./use-research-stream";

export interface ResearchProgressProps {
  events: ResearchEvent[];
  status: ResearchRunStatus;
}

const phases = ["Planning", "Searching", "Evaluating", "Synthesizing"] as const;

function phaseIndex(events: ResearchEvent[], status: ResearchRunStatus) {
  if (status === "completed" || status === "partial") return 4;
  const types = new Set(events.map((event) => event.type));
  if (types.has("report.started") || types.has("conclusion.updated")) return 3;
  if (types.has("source.read") || types.has("source.evaluated")) return 2;
  if (types.has("search.started") || types.has("search.completed")) return 1;
  return 0;
}

const statusCopy: Record<ResearchRunStatus, string> = {
  idle: "Ready to research",
  running: "Research running",
  completed: "Research completed",
  partial: "Partial report available",
  cancelled: "Research cancelled",
  failed: "Research failed",
};

export function ResearchProgress({ events, status }: ResearchProgressProps) {
  const activeIndex = phaseIndex(events, status);
  const sources = new Set<string>();
  let accepted = 0;
  let rejected = 0;
  let plan: Extract<ResearchEvent, { type: "plan.completed" }> | undefined;

  for (const event of events) {
    if (event.type === "search.completed") {
      for (const source of event.sources) sources.add(source.id);
    } else if (event.type === "source.evaluated") {
      if (event.evaluation.decision === "accepted") accepted += 1;
      else rejected += 1;
    } else if (event.type === "plan.completed") {
      plan = event;
    }
  }

  return (
    <aside className="progress-panel" aria-label="Research progress">
      <p className="eyebrow">Live workflow</p>
      <h2>{statusCopy[status]}</h2>
      <ol className="phase-list">
        {phases.map((phase, index) => {
          const phaseStatus =
            index < activeIndex
              ? "Completed"
              : index === activeIndex && status === "running"
                ? "Running"
                : "Pending";
          return (
            <li
              key={phase}
              className={`phase phase-${phaseStatus.toLowerCase()}`}
              aria-current={phaseStatus === "Running" ? "step" : undefined}
            >
              <span className="phase-marker" aria-hidden="true" />
              <span>
                <strong>{phase}</strong>
                <small>{phaseStatus}</small>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="counter-grid" aria-label="Research counters">
        <span><strong>{sources.size}</strong> {sources.size === 1 ? "source" : "sources"}</span>
        <span><strong>{accepted}</strong> accepted</span>
        <span><strong>{rejected}</strong> rejected</span>
      </div>

      {plan ? (
        <div className="plan-summary">
          <h3>Objective</h3>
          <p>{plan.plan.objective}</p>
          <h3>Questions</h3>
          <ul>
            {plan.plan.subquestions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}
