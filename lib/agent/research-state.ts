import type {
  ResearchPhase,
  ResearchPlan,
  ResearchReport,
  Source,
  SourceEvaluation,
} from "./research-types";

export interface ResearchState {
  question: string;
  phase: ResearchPhase;
  stepCount: number;
  plan?: ResearchPlan;
  sources: Source[];
  evaluations: SourceEvaluation[];
  gaps: string[];
  report?: ResearchReport;
  error?: string;
}

export type ResearchAction =
  | { type: "plan.completed"; payload: ResearchPlan }
  // Search history is observable transport data; workflow state only retains sources.
  | { type: "search.started"; payload: { query: string } }
  | {
      type: "search.completed";
      payload: { query: string; sources: Source[] };
    }
  | {
      type: "sources.evaluated";
      payload: { evaluations: SourceEvaluation[] };
    }
  | { type: "gap.detected"; payload: { gap: string } }
  | { type: "synthesis.started"; payload: Record<string, never> }
  | { type: "report.completed"; payload: { report: ResearchReport } }
  | {
      type: "research.partial";
      payload: { report?: ResearchReport; reason: string };
    }
  | { type: "research.cancelled"; payload: { reason?: string } }
  | { type: "research.failed"; payload: { error: string } };

const nextPhaseByAction = {
  "plan.completed": "searching",
  "search.started": "searching",
  "search.completed": "evaluating",
  "sources.evaluated": "evaluating",
  "gap.detected": "searching",
  "synthesis.started": "synthesizing",
  "report.completed": "completed",
  "research.partial": "partial",
  "research.cancelled": "cancelled",
  "research.failed": "failed",
} as const;

const legalActionsByPhase = {
  planning: ["plan.completed"],
  searching: ["search.started", "search.completed"],
  evaluating: [
    "search.started",
    "sources.evaluated",
    "gap.detected",
    "synthesis.started",
  ],
  synthesizing: ["report.completed", "research.partial"],
  completed: [],
  partial: [],
  cancelled: [],
  failed: [],
} as const satisfies Record<ResearchPhase, readonly ResearchAction["type"][]>;

function isLegalTransition(
  phase: ResearchPhase,
  actionType: ResearchAction["type"],
): boolean {
  if (
    actionType === "research.cancelled" ||
    actionType === "research.failed"
  ) {
    return ![
      "completed",
      "partial",
      "cancelled",
      "failed",
    ].includes(phase);
  }

  return (legalActionsByPhase[phase] as readonly ResearchAction["type"][]).includes(
    actionType,
  );
}

export function createResearchState(question: string): ResearchState {
  return {
    question,
    phase: "planning",
    stepCount: 0,
    sources: [],
    evaluations: [],
    gaps: [],
  };
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

function mergeSources(current: Source[], incoming: Source[]): Source[] {
  const sourcesByUrl = new Map(
    current.map((source) => [canonicalizeUrl(source.url), source]),
  );

  for (const source of incoming) {
    const canonicalUrl = canonicalizeUrl(source.url);
    if (!sourcesByUrl.has(canonicalUrl)) {
      sourcesByUrl.set(canonicalUrl, source);
    }
  }

  return [...sourcesByUrl.values()];
}

function mergeEvaluations(
  current: SourceEvaluation[],
  incoming: SourceEvaluation[],
): SourceEvaluation[] {
  const evaluationsBySource = new Map(
    current.map((evaluation) => [evaluation.sourceId, evaluation]),
  );

  for (const evaluation of incoming) {
    evaluationsBySource.set(evaluation.sourceId, evaluation);
  }

  return [...evaluationsBySource.values()];
}

// The reducer is the workflow's audit ledger. Keeping transitions here prevents
// model output, API transport, and UI code from inventing incompatible states.
export function reduceResearchState(
  state: ResearchState,
  action: ResearchAction,
): ResearchState {
  if (!isLegalTransition(state.phase, action.type)) {
    return state;
  }

  const nextState: ResearchState = {
    ...state,
    phase: nextPhaseByAction[action.type],
    stepCount: state.stepCount + 1,
  };

  switch (action.type) {
    case "plan.completed":
      return { ...nextState, plan: action.payload };
    case "search.completed":
      return {
        ...nextState,
        sources: mergeSources(state.sources, action.payload.sources),
      };
    case "sources.evaluated":
      return {
        ...nextState,
        evaluations: mergeEvaluations(
          state.evaluations,
          action.payload.evaluations,
        ),
      };
    case "gap.detected":
      return {
        ...nextState,
        gaps: state.gaps.includes(action.payload.gap)
          ? state.gaps
          : [...state.gaps, action.payload.gap],
      };
    case "report.completed":
      return { ...nextState, report: action.payload.report };
    case "research.partial":
      return {
        ...nextState,
        report: action.payload.report ?? state.report,
        error: action.payload.reason,
      };
    case "research.cancelled":
      return { ...nextState, error: action.payload.reason };
    case "research.failed":
      return { ...nextState, error: action.payload.error };
    case "search.started":
    case "synthesis.started":
      return nextState;
  }
}
