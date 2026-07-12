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
  evidenceAssessed: boolean;
  sourcesEvaluated: boolean;
  activeQuery?: string;
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
  | { type: "sources.read"; payload: { sources: Source[] } }
  | {
      type: "sources.evaluated";
      payload: { evaluations: SourceEvaluation[] };
    }
  | { type: "evidence.assessed"; payload: { summary: string } }
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
  "sources.read": "evaluating",
  "sources.evaluated": "evaluating",
  "evidence.assessed": "evaluating",
  "gap.detected": "searching",
  "synthesis.started": "synthesizing",
  "report.completed": "completed",
  "research.partial": "partial",
  "research.cancelled": "cancelled",
  "research.failed": "failed",
} as const;

const legalActionsByPhase = {
  planning: ["plan.completed"],
  searching: [
    "search.started",
    "search.completed",
    "sources.evaluated",
    "synthesis.started",
  ],
  evaluating: [
    "search.started",
    "sources.evaluated",
    "sources.read",
    "evidence.assessed",
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
  state: ResearchState,
  action: ResearchAction,
): boolean {
  const { phase } = state;
  const actionType = action.type;
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

  const phaseAllows = (legalActionsByPhase[phase] as readonly ResearchAction["type"][]).includes(
    actionType,
  );
  if (!phaseAllows) return false;

  if (action.type === "search.started") {
    return !state.activeQuery && (
      state.phase === "searching" || state.evidenceAssessed
    );
  }
  if (action.type === "search.completed") {
    return state.activeQuery === action.payload.query;
  }
  if (action.type === "evidence.assessed") {
    return !state.activeQuery && state.sourcesEvaluated;
  }
  if (action.type === "sources.read" || action.type === "sources.evaluated") {
    return !state.evidenceAssessed;
  }
  if (action.type === "gap.detected" || action.type === "synthesis.started") {
    return state.evidenceAssessed && !state.activeQuery;
  }
  return true;
}

export function createResearchState(question: string): ResearchState {
  return {
    question,
    phase: "planning",
    stepCount: 0,
    sources: [],
    evaluations: [],
    evidenceAssessed: false,
    sourcesEvaluated: false,
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
  if (!isLegalTransition(state, action)) {
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
        evidenceAssessed: false,
        sourcesEvaluated: false,
        activeQuery: undefined,
      };
    case "sources.read": {
      const updates = new Map(
        action.payload.sources.map((source) => [
          canonicalizeUrl(source.url),
          source,
        ]),
      );
      return {
        ...nextState,
        evidenceAssessed: false,
        sources: state.sources.map((source) =>
          updates.get(canonicalizeUrl(source.url)) ?? source,
        ),
      };
    }
    case "sources.evaluated":
      return {
        ...nextState,
        evidenceAssessed: false,
        sourcesEvaluated: true,
        evaluations: mergeEvaluations(
          state.evaluations,
          action.payload.evaluations,
        ),
      };
    case "evidence.assessed":
      return { ...nextState, evidenceAssessed: true };
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
      return { ...nextState, activeQuery: action.payload.query };
    case "synthesis.started":
      return nextState;
  }
}
