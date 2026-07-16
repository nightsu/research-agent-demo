import type { ResearchEvent } from "@/lib/agent/research-events";
import { canonicalizeUrl } from "@/lib/agent/research-state";
import type {
  ResearchPlan,
  ResearchReport,
  Source,
  SourceEvaluation,
} from "@/lib/agent/research-types";

import type { ResearchRunStatus } from "./use-research-stream";

export interface ResearchCounters {
  sources: number;
  accepted: number;
  rejected: number;
}

export type ResearchMetrics = Omit<
  Extract<ResearchEvent, { type: "progress.updated" }>,
  "type"
>;

export type WorkflowPhase =
  | "planning"
  | "searching"
  | "evaluating"
  | "synthesizing";

export interface ResearchViewModel {
  sources: Source[];
  evaluations: Map<string, SourceEvaluation>;
  report?: ResearchReport;
  plan?: ResearchPlan;
  counters: ResearchCounters;
  latestEvent?: ResearchEvent;
  latestEventLabel: string;
  currentPhase: WorkflowPhase;
  citationNumbers: Map<string, number>;
  sourceIdentityById: Map<string, string>;
  metrics?: ResearchMetrics;
}

export function eventStatusLabel(event?: ResearchEvent): string {
  if (!event) return "Waiting for first event";
  switch (event.type) {
    case "plan.started": return "Planning started";
    case "progress.updated": return "Workflow progress updated";
    case "plan.completed": return "Plan completed";
    case "search.started": return "Search running";
    case "search.completed": return "Search completed";
    case "source.read": return "Source read";
    case "source.evaluated": return `Source ${event.evaluation.decision}`;
    case "gap.detected": return "Evidence gap detected";
    case "conclusion.updated": return "Conclusion updated";
    case "report.started": return event.partial ? "Partial report started" : "Report synthesis running";
    case "report.delta": return "Report draft updated";
    case "report.validating": return "Report validating";
    case "report.repairing": return "Report repairing";
    case "report.completed": return "Report completed";
    case "research.partial": return "Partial research completed";
    case "research.cancelled": return "Research cancelled";
    case "research.failed": return "Research failed";
  }
}

export const runStatusLabel: Record<ResearchRunStatus, string> = {
  idle: "Ready to research",
  running: "Research running",
  completed: "Research completed",
  partial: "Partial report available",
  cancelled: "Research cancelled",
  failed: "Research failed",
};

function phaseForLatestEvent(event?: ResearchEvent): WorkflowPhase | undefined {
  if (!event) return "planning";
  switch (event.type) {
    case "plan.started": return "planning";
    case "progress.updated": return undefined;
    case "plan.completed":
    case "search.started":
    case "gap.detected": return "searching";
    case "search.completed":
    case "source.read":
    case "source.evaluated":
    case "conclusion.updated": return "evaluating";
    case "report.started":
    case "report.delta":
    case "report.validating":
    case "report.repairing": return "synthesizing";
    case "report.completed":
    case "research.partial":
    case "research.cancelled":
    case "research.failed": return undefined;
  }
}

/** Numbers retained sources in order; aliases inherit an included canonical identity. */
export function buildCitationNumbers(
  sources: Source[],
  sourceIdentityById: ReadonlyMap<string, string> = new Map(),
  acceptedIdentities?: ReadonlySet<string>,
): Map<string, number> {
  const numbers = new Map<string, number>();
  const numberedSources = acceptedIdentities
    ? sources.filter((source) => acceptedIdentities.has(source.id))
    : sources;
  numberedSources.forEach((source, index) => numbers.set(source.id, index + 1));
  for (const [alias, identity] of sourceIdentityById) {
    const number = numbers.get(identity);
    if (number) numbers.set(alias, number);
  }
  return numbers;
}

export function deriveResearchViewModel(
  events: ResearchEvent[],
): ResearchViewModel {
  const sources: Source[] = [];
  const sourceByCanonicalUrl = new Map<string, Source>();
  const sourceIdentityById = new Map<string, string>();
  let report: ResearchReport | undefined;
  let plan: ResearchPlan | undefined;
  let metrics: ResearchMetrics | undefined;

  for (const event of events) {
    if (event.type === "plan.completed") plan = event.plan;
    if (event.type === "progress.updated") {
      const { operationCount, operationLimit, searchRounds, searchRoundLimit } = event;
      metrics = { operationCount, operationLimit, searchRounds, searchRoundLimit };
    }
    if (event.type !== "search.completed") continue;
    for (const source of event.sources) {
      const canonicalUrl = canonicalizeUrl(source.url);
      const existing = sourceByCanonicalUrl.get(canonicalUrl);
      if (existing) {
        sourceIdentityById.set(source.id, existing.id);
        continue;
      }
      if (sourceIdentityById.has(source.id)) continue;
      sourceByCanonicalUrl.set(canonicalUrl, source);
      sourceIdentityById.set(source.id, source.id);
      sources.push(source);
    }
  }

  const evaluations = new Map<string, SourceEvaluation>();
  for (const event of events) {
    if (event.type === "source.evaluated") {
      const identity = sourceIdentityById.get(event.evaluation.sourceId) ?? event.evaluation.sourceId;
      evaluations.set(identity, event.evaluation);
    } else if (event.type === "report.completed" || event.type === "research.partial") {
      report = event.report;
    }
  }

  let accepted = 0;
  let rejected = 0;
  for (const source of sources) {
    const decision = evaluations.get(source.id)?.decision;
    if (decision === "accepted") accepted += 1;
    else if (decision === "rejected") rejected += 1;
  }

  const latestEvent = events.at(-1);
  const acceptedIdentities = new Set(
    [...evaluations]
      .filter(([, evaluation]) => evaluation.decision === "accepted")
      .map(([identity]) => identity),
  );
  const currentPhase = events
    .toReversed()
    .map(phaseForLatestEvent)
    .find((phase): phase is WorkflowPhase => phase !== undefined) ?? "planning";
  const base = {
    sources,
    evaluations,
    counters: { sources: sources.length, accepted, rejected },
    latestEventLabel: eventStatusLabel(latestEvent),
    currentPhase,
    citationNumbers: buildCitationNumbers(
      sources,
      sourceIdentityById,
      acceptedIdentities,
    ),
    sourceIdentityById,
  };

  return {
    ...base,
    ...(latestEvent ? { latestEvent } : {}),
    ...(report ? { report } : {}),
    ...(plan ? { plan } : {}),
    ...(metrics ? { metrics } : {}),
  };
}
