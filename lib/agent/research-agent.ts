import {
  defaultResearchLimits,
  quickResearchLimits,
  type ResearchLimits,
} from "./limits";
import { researchEventSchema, type ResearchEvent } from "./research-events";
import {
  canonicalizeUrl,
  createResearchState,
  reduceResearchState,
  type ResearchAction,
  type ResearchState,
} from "./research-state";
import {
  researchInputSchema,
  type ResearchInput,
  type Source,
} from "./research-types";
import {
  validateReportCitations,
  type ResearchModel,
} from "../providers/research-model";
import {
  extractSources as defaultExtractSources,
  searchWeb as defaultSearchWeb,
  TavilyError,
} from "../tools/tavily";

export interface ResearchDependencies {
  model: ResearchModel;
  searchWeb: typeof defaultSearchWeb;
  extractSources: typeof defaultExtractSources;
  emit: (event: ResearchEvent) => void | Promise<void>;
  limits?: ResearchLimits;
}

class OperationBudgetError extends Error {
  constructor() {
    super("Research operation step limit reached");
    this.name = "OperationBudgetError";
  }
}

class RequestTimeoutError extends Error {
  readonly recoverable = true;

  constructor(timeoutMs: number) {
    super(`Research request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Research failed";
}

function uniqueSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const url = canonicalizeUrl(source.url);
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

export async function runResearch(
  rawInput: ResearchInput,
  deps: ResearchDependencies,
  signal?: AbortSignal,
): Promise<ResearchState> {
  const runtimeQuestion = (rawInput as Partial<ResearchInput> | null)?.question;
  let state = createResearchState(
    typeof runtimeQuestion === "string"
      ? runtimeQuestion
      : "Invalid research request",
  );
  let eventTimeoutMs = defaultResearchLimits.requestTimeoutMs;

  const emit = async (event: ResearchEvent) => {
    const parsed = researchEventSchema.parse(event);
    const controller = new AbortController();
    const observeParent = event.type !== "research.cancelled";
    const onParentAbort = () => controller.abort(signal?.reason);
    if (observeParent) {
      if (signal?.aborted) onParentAbort();
      else signal?.addEventListener("abort", onParentAbort, { once: true });
    }
    const timeout = new RequestTimeoutError(eventTimeoutMs);
    const timer = setTimeout(() => controller.abort(timeout), eventTimeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([Promise.resolve(deps.emit(parsed)), aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParentAbort);
    }
  };

  const transition = async (
    action: ResearchAction,
    events: ResearchEvent[] = [],
  ) => {
    const next = reduceResearchState(state, action);
    if (next === state) {
      throw new Error(
        `Illegal research transition: ${state.phase} -> ${action.type}`,
      );
    }
    for (const event of events) await emit(event);
    state = next;
  };

  const fail = async (error: unknown, recoverable = false): Promise<never> => {
    const message = errorMessage(error);
    await transition(
      { type: "research.failed", payload: { error: message } },
      [{ type: "research.failed", message, recoverable }],
    );
    throw error;
  };

  const parsedInput = researchInputSchema.safeParse(rawInput);
  if (!parsedInput.success) return fail(parsedInput.error, false);
  const input = parsedInput.data;
  state = createResearchState(input.question);

  const limits = deps.limits ?? (
    input.depth === "quick" ? quickResearchLimits : defaultResearchLimits
  );
  eventTimeoutMs = limits.requestTimeoutMs;
  let operationCount = 0;

  const invoke = async <T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (operationCount >= limits.maxSteps) throw new OperationBudgetError();
    operationCount += 1;

    const controller = new AbortController();
    const onParentAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener("abort", onParentAbort, { once: true });

    const timeoutReason = new RequestTimeoutError(limits.requestTimeoutMs);
    const timer = setTimeout(
      () => controller.abort(timeoutReason),
      limits.requestTimeoutMs,
    );
    let removeOperationAbortListener = () => {};
    const operationAborted = new Promise<never>((_resolve, reject) => {
      const onOperationAbort = () =>
        reject(
          controller.signal.reason ?? new DOMException("Aborted", "AbortError"),
        );
      if (controller.signal.aborted) onOperationAbort();
      else {
        controller.signal.addEventListener("abort", onOperationAbort, { once: true });
        removeOperationAbortListener = () =>
          controller.signal.removeEventListener("abort", onOperationAbort);
      }
    });

    try {
      return await Promise.race([operation(controller.signal), operationAborted]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (
        controller.signal.aborted &&
        controller.signal.reason === timeoutReason
      ) {
        throw timeoutReason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      removeOperationAbortListener();
      signal?.removeEventListener("abort", onParentAbort);
    }
  };

  const invokeModel = async <T>(
    operation: (options: {
      abortSignal: AbortSignal;
      onModelCall: () => void;
    }) => Promise<T>,
  ): Promise<T> => {
    let firstProviderCall = true;
    return invoke((abortSignal) =>
      operation({
        abortSignal,
        onModelCall: () => {
          if (firstProviderCall) {
            firstProviderCall = false;
            return;
          }
          if (operationCount >= limits.maxSteps) throw new OperationBudgetError();
          operationCount += 1;
        },
      }),
    );
  };

  const cancel = async (): Promise<ResearchState> => {
    await transition(
      {
        type: "research.cancelled",
        payload: {
          reason: signal?.reason ? errorMessage(signal.reason) : undefined,
        },
      },
      [{ type: "research.cancelled" }],
    );
    return state;
  };

  if (signal?.aborted) return cancel();

  try {
    await emit({ type: "plan.started", question: input.question });
    const researchPlan = await invokeModel((options) =>
      deps.model.generatePlan(input.question, options),
    );
    await transition(
      { type: "plan.completed", payload: researchPlan },
      [{ type: "plan.completed", plan: researchPlan }],
    );

    const seenQueries = new Set<string>();
    const pendingQueries: Array<{ query: string; reason: string }> = [];
    for (const query of researchPlan.searchQueries) {
      const key = query.trim().toLocaleLowerCase();
      if (!seenQueries.has(key)) {
        seenQueries.add(key);
        pendingQueries.push({ query, reason: "Research plan query" });
      }
    }

    const attemptedReadUrls = new Set<string>();
    let searchRounds = 0;
    let evidenceSufficient = false;
    let partialReason = "No additional search queries were available";

    // This loop is intentionally explicit instead of delegated to ToolLoopAgent.
    // Each boundary becomes a stable UI event and a testable teaching checkpoint,
    // while the model still decides the research plan, evidence quality, and gaps.
    while (pendingQueries.length > 0 && searchRounds < limits.maxSearchRounds) {
      // Preserve enough operations for search, evaluation, assessment, and
      // report generation. Extraction uses an additional slot when available.
      if (operationCount + 4 > limits.maxSteps) {
        partialReason = "Research operation step limit reached";
        break;
      }

      const nextQuery = pendingQueries.shift()!;
      searchRounds += 1;
      const reason = nextQuery.reason === "Evidence gap follow-up"
        ? nextQuery.reason
        : `Research plan query ${searchRounds}`;
      await transition(
        { type: "search.started", payload: { query: nextQuery.query } },
        [{ type: "search.started", query: nextQuery.query, reason }],
      );

      let searchResults: Source[];
      try {
        searchResults = await invoke((abortSignal) =>
          deps.searchWeb(nextQuery.query, { timeRange: input.timeRange }, abortSignal),
        );
      } catch (error) {
        if (!(error instanceof TavilyError) || !error.recoverable || signal?.aborted) {
          throw error;
        }
        // A retry is useful only when the remaining budget can still evaluate,
        // assess, and synthesize the successful result.
        if (operationCount + 4 > limits.maxSteps) throw error;
        searchResults = await invoke((abortSignal) =>
          deps.searchWeb(nextQuery.query, { timeRange: input.timeRange }, abortSignal),
        );
      }

      const cappedSources = uniqueSources(
        searchResults.slice(0, limits.maxResultsPerRound),
      );
      await transition(
        {
          type: "search.completed",
          payload: { query: nextQuery.query, sources: cappedSources },
        },
        [{
          type: "search.completed",
          query: nextQuery.query,
          sources: cappedSources,
          resultCount: searchResults.length,
        }],
      );

      const unread = state.sources
        .filter((source) => {
          const url = canonicalizeUrl(source.url);
          return !source.rawContent && !attemptedReadUrls.has(url);
        })
        .slice(
          0,
          Math.max(0, limits.maxSourcesToRead - attemptedReadUrls.size),
        );

      if (unread.length > 0 && operationCount + 4 <= limits.maxSteps) {
        unread.forEach((source) =>
          attemptedReadUrls.add(canonicalizeUrl(source.url)),
        );
        const extracted = await invoke((abortSignal) =>
          deps.extractSources(
            unread.map((source) => source.url),
            input.question,
            abortSignal,
          ),
        );
        const readSources = unread.flatMap((source) => {
          const content =
            extracted.get(source.url) ??
            extracted.get(canonicalizeUrl(source.url));
          return content ? [{ ...source, rawContent: content }] : [];
        });

        if (readSources.length > 0) {
          await transition(
            { type: "sources.read", payload: { sources: readSources } },
            readSources.map((source) => ({
              type: "source.read",
              sourceId: source.id,
              url: source.url,
            })),
          );
        }
      }

      const evaluations = await invokeModel((options) =>
        deps.model.evaluateSources(input.question, state.sources, options),
      );
      await transition(
        { type: "sources.evaluated", payload: { evaluations } },
        evaluations.map((item) => ({
          type: "source.evaluated",
          evaluation: item,
        })),
      );

      const assessment = await invokeModel((options) =>
        deps.model.assessEvidence(
          input.question,
          state.sources,
          state.evaluations,
          options,
        ),
      );
      await transition(
        { type: "evidence.assessed", payload: { summary: assessment.summary } },
        [{ type: "conclusion.updated", summary: assessment.summary }],
      );
      evidenceSufficient = assessment.sufficient;
      if (evidenceSufficient) break;

      const gapDescription = assessment.gaps.join("; ").trim();
      const uniqueFollowUps = assessment.followUpQueries.filter((query) => {
        const key = query.trim().toLocaleLowerCase();
        if (!key || seenQueries.has(key)) return false;
        seenQueries.add(key);
        return true;
      });

      if (gapDescription || uniqueFollowUps.length > 0) {
        const description = gapDescription || assessment.summary;
        await transition(
          { type: "gap.detected", payload: { gap: description } },
          [{
          type: "gap.detected",
          description,
          followUpQueries: assessment.followUpQueries,
          }],
        );
        for (const query of uniqueFollowUps.reverse()) {
          pendingQueries.unshift({ query, reason: "Evidence gap follow-up" });
        }
      }
    }

    if (!state.evidenceAssessed) {
      if (!state.sourcesEvaluated) {
        const evaluations = await invokeModel((options) =>
          deps.model.evaluateSources(input.question, state.sources, options),
        );
        await transition(
          { type: "sources.evaluated", payload: { evaluations } },
          evaluations.map((item) => ({
            type: "source.evaluated",
            evaluation: item,
          })),
        );
      }
      const assessment = await invokeModel((options) =>
        deps.model.assessEvidence(
          input.question,
          state.sources,
          state.evaluations,
          options,
        ),
      );
      await transition(
        { type: "evidence.assessed", payload: { summary: assessment.summary } },
        [{ type: "conclusion.updated", summary: assessment.summary }],
      );
      evidenceSufficient = searchRounds > 0 && assessment.sufficient;
    }

    if (!evidenceSufficient) {
      if (searchRounds >= limits.maxSearchRounds) {
        partialReason = "Maximum search rounds reached";
      } else if (operationCount >= limits.maxSteps - 1) {
        partialReason = "Research operation step limit reached";
      }
    }

    const partial = !evidenceSufficient;
    await transition(
      { type: "synthesis.started", payload: {} },
      [{ type: "report.started", partial }],
    );
    const report = await invokeModel((options) =>
      deps.model.generateReport(
        input.question,
        state.sources,
        state.evaluations,
        partial,
        options,
      ),
    );
    if (signal?.aborted) return cancel();
    validateReportCitations(state.sources, state.evaluations, report);

    if (partial) {
      await transition(
        { type: "research.partial", payload: { report, reason: partialReason } },
        [{ type: "research.partial", report, reason: partialReason }],
      );
    } else {
      await transition(
        { type: "report.completed", payload: { report } },
        [{ type: "report.completed", report }],
      );
    }
    return state;
  } catch (error) {
    if (signal?.aborted) return cancel();
    const recoverable = error instanceof TavilyError
      ? error.recoverable
      : error instanceof RequestTimeoutError;
    return fail(error, recoverable);
  }
}
