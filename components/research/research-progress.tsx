import type { ResearchRunStatus } from "./use-research-stream";
import { runStatusLabel, type ResearchViewModel } from "./research-view-model";

export interface ResearchProgressProps {
  viewModel: ResearchViewModel;
  status: ResearchRunStatus;
}

const phases = ["Planning", "Searching", "Evaluating", "Synthesizing"] as const;

function phaseIndex(phase: ResearchViewModel["currentPhase"]): number {
  return { planning: 0, searching: 1, evaluating: 2, synthesizing: 3 }[phase];
}

export function ResearchProgress({ viewModel, status }: ResearchProgressProps) {
  const activeIndex = phaseIndex(viewModel.currentPhase);
  const { counters, plan } = viewModel;

  return (
    <aside className="progress-panel" aria-label="Research progress">
      <p className="eyebrow">Live workflow</p>
      <h2>{runStatusLabel[status]}</h2>
      <ol className="phase-list">
        {phases.map((phase, index) => {
          let phaseStatus: "Completed" | "Running" | "Pending" | "Cancelled" | "Failed";
          if (status === "completed" || status === "partial" || index < activeIndex) {
            phaseStatus = "Completed";
          } else if (index === activeIndex && status === "running") {
            phaseStatus = "Running";
          } else if (index === activeIndex && status === "cancelled") {
            phaseStatus = "Cancelled";
          } else if (index === activeIndex && status === "failed") {
            phaseStatus = "Failed";
          } else {
            phaseStatus = "Pending";
          }
          return (
            <li
              key={phase}
              className={`phase phase-${phaseStatus.toLowerCase()}`}
              aria-current={
                phaseStatus === "Running" ||
                phaseStatus === "Cancelled" ||
                phaseStatus === "Failed"
                  ? "step"
                  : undefined
              }
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
        <span><strong>{counters.sources}</strong> {counters.sources === 1 ? "source" : "sources"}</span>
        <span><strong>{counters.accepted}</strong> accepted</span>
        <span><strong>{counters.rejected}</strong> rejected</span>
      </div>

      {plan ? (
        <div className="plan-summary">
          <h3>Objective</h3>
          <p>{plan.objective}</p>
          <h3>Questions</h3>
          <ul>
            {plan.subquestions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}
