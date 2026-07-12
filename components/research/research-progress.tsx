import type { ResearchRunStatus } from "./use-research-stream";
import { runStatusLabel, type ResearchViewModel } from "./research-view-model";

export interface ResearchProgressProps {
  viewModel: ResearchViewModel;
  status: ResearchRunStatus;
}

const phases = ["Planning", "Searching", "Evaluating", "Synthesizing"] as const;

function phaseIndex(phase: ResearchViewModel["currentPhase"]): number {
  if (phase === "completed" || phase === "partial") return 4;
  return { planning: 0, searching: 1, evaluating: 2, synthesizing: 3, cancelled: 0, failed: 0 }[phase];
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
