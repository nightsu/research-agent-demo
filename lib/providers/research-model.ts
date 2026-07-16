import { generateText, NoObjectGeneratedError, Output, streamText } from "ai";
import { toJSONSchema, z, ZodError, type ZodType } from "zod";

import {
  evidenceAssessmentSchema,
  reportSchema,
  researchPlanSchema,
  sourceEvaluationSchema,
  type EvidenceAssessment,
  type ResearchPlan,
  type ResearchReport,
  type Source,
  type SourceEvaluation,
} from "../agent/research-types";
import {
  RESEARCH_SYSTEM_PROMPT,
  evidencePrompt,
  planPrompt,
  reportPrompt,
  sourceEvaluationPrompt,
} from "../agent/prompts";
import type { PartialResearchReport } from "../agent/report-draft";
import { getResearchModel } from "./index";

export interface ResearchModel {
  generatePlan(
    question: string,
    options?: ResearchModelOptions,
  ): Promise<ResearchPlan>;
  evaluateSources(
    question: string,
    sources: Source[],
    options?: ResearchModelOptions,
  ): Promise<SourceEvaluation[]>;
  assessEvidence(
    question: string,
    sources: Source[],
    evaluations: SourceEvaluation[],
    options?: ResearchModelOptions,
  ): Promise<EvidenceAssessment>;
  generateReport(
    question: string,
    sources: Source[],
    evaluations: SourceEvaluation[],
    partial: boolean,
    options?: ResearchReportModelOptions,
  ): Promise<ResearchReport>;
}

export interface ResearchModelOptions {
  abortSignal?: AbortSignal;
  onModelCall?: () => void;
}

export interface ResearchReportModelOptions extends ResearchModelOptions {
  /**
   * Receives structured report snapshots in generation order. Implementations
   * must invoke and await this callback serially: Agent diff/sequence state and
   * route transport backpressure both depend on the previous delivery settling.
   */
  onPartialReport?: (
    partial: PartialResearchReport,
  ) => void | Promise<void>;
  /** Called only after every prior partial callback settles, and must be awaited. */
  onValidating?: () => void | Promise<void>;
  /** Called after validation and prior partial callbacks settle, and must be awaited. */
  onRepairing?: () => void | Promise<void>;
}

export class MissingStructuredOutputError extends Error {
  constructor() {
    super("The model returned no structured output");
    this.name = "MissingStructuredOutputError";
  }
}

const sourceEvaluationsSchema = sourceEvaluationSchema.array().max(50);
const sourceEvaluationsOutputSchema = z.object({
  evaluations: sourceEvaluationsSchema,
});

function appendJsonContract<T>(prompt: string, schema: ZodType<T>): string {
  const jsonSchema = JSON.stringify(
    toJSONSchema(schema, { target: "draft-7" }),
  );

  return `${prompt}

Return only one JSON object.
Use the exact property names from this JSON Schema.
Do not wrap the JSON in Markdown or add explanatory text.
Output JSON Schema:
${jsonSchema}`;
}

function isRepairableStructuredOutputError(error: unknown): boolean {
  return (
    error instanceof MissingStructuredOutputError ||
    NoObjectGeneratedError.isInstance(error) ||
    error instanceof ZodError
  );
}

function createRepairPrompt(prompt: string): string {
  return `${prompt}

Repair instruction: the previous generation failed validation. Generate the full response again and satisfy the exact structured output constraints. Do not discuss the failure.`;
}

export function validateSourceEvaluations(
  sources: Source[],
  evaluations: SourceEvaluation[],
): SourceEvaluation[] {
  const expectedSourceIds = new Set(sources.map((source) => source.id));
  const integritySchema = sourceEvaluationsSchema.superRefine(
    (items, context) => {
      const counts = new Map<string, number>();

      items.forEach((evaluation, index) => {
        counts.set(
          evaluation.sourceId,
          (counts.get(evaluation.sourceId) ?? 0) + 1,
        );

        if (!expectedSourceIds.has(evaluation.sourceId)) {
          context.addIssue({
            code: "custom",
            message: `Unknown source ID: ${evaluation.sourceId}`,
            path: [index, "sourceId"],
          });
        }
      });

      for (const sourceId of expectedSourceIds) {
        const count = counts.get(sourceId) ?? 0;
        if (count !== 1) {
          context.addIssue({
            code: "custom",
            message: `Expected exactly one evaluation for source ID: ${sourceId}`,
          });
        }
      }
    },
  );

  return integritySchema.parse(evaluations);
}

export function validateReportCitations(
  sources: Source[],
  evaluations: SourceEvaluation[],
  report: ResearchReport,
): ResearchReport {
  const sourceIds = new Set(sources.map((source) => source.id));
  const acceptedSourceIds = new Set(
    evaluations
      .filter(
        (evaluation) =>
          evaluation.decision === "accepted" &&
          sourceIds.has(evaluation.sourceId),
      )
      .map((evaluation) => evaluation.sourceId),
  );
  const citationSchema = reportSchema.superRefine((value, context) => {
    value.findings.forEach((finding, findingIndex) => {
      finding.sourceIds.forEach((sourceId, sourceIndex) => {
        if (!acceptedSourceIds.has(sourceId)) {
          context.addIssue({
            code: "custom",
            message: `Citation must reference an accepted source ID: ${sourceId}`,
            path: ["findings", findingIndex, "sourceIds", sourceIndex],
          });
        }
      });
    });
  });

  return citationSchema.parse(report);
}

function selectAcceptedEvidence(
  sources: Source[],
  evaluations: SourceEvaluation[],
): { sources: Source[]; evaluations: SourceEvaluation[] } {
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const acceptedEvaluations = evaluations.filter(
    (evaluation) =>
      evaluation.decision === "accepted" &&
      knownSourceIds.has(evaluation.sourceId),
  );
  const acceptedSourceIds = new Set(
    acceptedEvaluations.map((evaluation) => evaluation.sourceId),
  );

  return {
    sources: sources.filter((source) => acceptedSourceIds.has(source.id)),
    evaluations: acceptedEvaluations,
  };
}

async function generateValidated<T>(
  schema: ZodType<T>,
  prompt: string,
  maxOutputTokens: number,
  options: ResearchModelOptions = {},
  validate: (output: T) => T = (output) => output,
): Promise<T> {
  const model = getResearchModel();

  const attempt = async (attemptPrompt: string): Promise<T> => {
    return generateStructuredAttempt(
      model,
      schema,
      attemptPrompt,
      maxOutputTokens,
      options,
      validate,
    );
  };

  try {
    return await attempt(prompt);
  } catch (initialError) {
    if (!isRepairableStructuredOutputError(initialError)) {
      throw initialError;
    }

    // Only malformed structured output gets one repair generation. Transport,
    // authentication, rate-limit, and cancellation failures remain single-call.
    try {
      return await attempt(createRepairPrompt(prompt));
    } catch (repairError) {
      throw new AggregateError(
        [initialError, repairError],
        "Structured generation failed after one repair attempt",
      );
    }
  }
}

async function generateStructuredAttempt<T>(
  model: ReturnType<typeof getResearchModel>,
  schema: ZodType<T>,
  prompt: string,
  maxOutputTokens: number,
  options: ResearchModelOptions,
  validate: (output: T) => T,
): Promise<T> {
  options.onModelCall?.();
  const result = await generateText({
    model,
    system: RESEARCH_SYSTEM_PROMPT,
    prompt: appendJsonContract(prompt, schema),
    output: Output.json(),
    abortSignal: options.abortSignal,
    maxOutputTokens,
  });

  if (result.output == null) {
    throw new MissingStructuredOutputError();
  }

  // Output.json parses JSON syntax; Zod remains the final application boundary.
  return validate(schema.parse(result.output));
}

async function settleStructuredOutput(result: {
  readonly output: PromiseLike<unknown>;
}): Promise<void> {
  try {
    await result.output;
  } catch {
    // 这里只负责释放 tee 分支，cleanup 错误不能覆盖调用方真正需要处理的首个错误。
  }
}

async function generateStreamingReport(
  prompt: string,
  sources: Source[],
  evaluations: SourceEvaluation[],
  options: ResearchReportModelOptions = {},
): Promise<ResearchReport> {
  const model = getResearchModel();
  const streamAbortController = new AbortController();
  const streamAbortSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, streamAbortController.signal])
    : streamAbortController.signal;

  options.onModelCall?.();
  const result = streamText({
    model,
    system: RESEARCH_SYSTEM_PROMPT,
    prompt,
    output: Output.object({ schema: reportSchema }),
    abortSignal: streamAbortSignal,
    maxOutputTokens: 12_000,
  });

  try {
    for await (const partial of result.partialOutputStream) {
      await options.onPartialReport?.(partial);
    }
  } catch (streamError) {
    streamAbortController.abort(streamError);

    // partial 分支提前退出后必须收走 tee 的 output 分支，否则 SDK 会继续缓冲。
    await settleStructuredOutput(result);

    throw streamError;
  }

  try {
    await options.onValidating?.();
  } catch (validatingError) {
    await settleStructuredOutput(result);
    throw validatingError;
  }

  try {
    const output = await result.output;
    return validateReportCitations(sources, evaluations, output);
  } catch (initialError) {
    if (!isRepairableStructuredOutputError(initialError)) {
      throw initialError;
    }

    await options.onRepairing?.();

    try {
      // 第二次生成仅用于修复最终结构，不能重播另一份草稿去清空或反转用户正在阅读的内容。
      return await generateStructuredAttempt(
        model,
        reportSchema,
        createRepairPrompt(prompt),
        12_000,
        options,
        (output) => validateReportCitations(sources, evaluations, output),
      );
    } catch (repairError) {
      if (!isRepairableStructuredOutputError(repairError)) {
        throw repairError;
      }

      throw new AggregateError(
        [initialError, repairError],
        "Structured generation failed after one repair attempt",
      );
    }
  }
}

export function createResearchModel(): ResearchModel {
  return {
    generatePlan(question, options) {
      return generateValidated(
        researchPlanSchema,
        planPrompt(question),
        2_500,
        options,
      );
    },
    async evaluateSources(question, sources, options) {
      const output = await generateValidated(
        sourceEvaluationsOutputSchema,
        sourceEvaluationPrompt(question, sources),
        6_000,
        options,
        (value) => ({
          evaluations: validateSourceEvaluations(sources, value.evaluations),
        }),
      );

      return output.evaluations;
    },
    assessEvidence(question, sources, evaluations, options) {
      const accepted = selectAcceptedEvidence(sources, evaluations);

      return generateValidated(
        evidenceAssessmentSchema,
        evidencePrompt(question, accepted.sources, accepted.evaluations),
        2_500,
        options,
      );
    },
    generateReport(question, sources, evaluations, partial, options) {
      const accepted = selectAcceptedEvidence(sources, evaluations);

      return generateStreamingReport(
        reportPrompt(
          question,
          accepted.sources,
          accepted.evaluations,
          partial,
        ),
        sources,
        evaluations,
        options,
      );
    },
  };
}
