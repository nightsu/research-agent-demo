import { generateText, NoObjectGeneratedError, Output } from "ai";
import { ZodError, type ZodType } from "zod";

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
    options?: ResearchModelOptions,
  ): Promise<ResearchReport>;
}

export interface ResearchModelOptions {
  abortSignal?: AbortSignal;
  onModelCall?: () => void;
}

export class MissingStructuredOutputError extends Error {
  constructor() {
    super("The model returned no structured output");
    this.name = "MissingStructuredOutputError";
  }
}

function isRepairableStructuredOutputError(error: unknown): boolean {
  return (
    error instanceof MissingStructuredOutputError ||
    NoObjectGeneratedError.isInstance(error) ||
    error instanceof ZodError
  );
}

export function validateSourceEvaluations(
  sources: Source[],
  evaluations: SourceEvaluation[],
): SourceEvaluation[] {
  const expectedSourceIds = new Set(sources.map((source) => source.id));
  const integritySchema = sourceEvaluationSchema.array().superRefine(
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
  options: ResearchModelOptions = {},
  validate: (output: T) => T = (output) => output,
): Promise<T> {
  const model = getResearchModel();

  const attempt = async (attemptPrompt: string): Promise<T> => {
    options.onModelCall?.();
    const result = await generateText({
      model,
      system: RESEARCH_SYSTEM_PROMPT,
      prompt: attemptPrompt,
      output: Output.object({ schema }),
      abortSignal: options.abortSignal,
    });

    if (result.output == null) {
      throw new MissingStructuredOutputError();
    }

    // Output.object validates the provider response, and this parse keeps the
    // application schema as the final boundary even for mocked or future SDK results.
    return validate(schema.parse(result.output));
  };

  try {
    return await attempt(prompt);
  } catch (initialError) {
    if (!isRepairableStructuredOutputError(initialError)) {
      throw initialError;
    }

    // Only malformed structured output gets one repair generation. Transport,
    // authentication, rate-limit, and cancellation failures remain single-call.
    const repairPrompt = `${prompt}

Repair instruction: the previous generation failed validation. Generate the full response again and satisfy the exact structured output constraints. Do not discuss the failure.`;

    try {
      return await attempt(repairPrompt);
    } catch (repairError) {
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
        options,
      );
    },
    evaluateSources(question, sources, options) {
      return generateValidated(
        sourceEvaluationSchema.array(),
        sourceEvaluationPrompt(question, sources),
        options,
        (output) => validateSourceEvaluations(sources, output),
      );
    },
    assessEvidence(question, sources, evaluations, options) {
      const accepted = selectAcceptedEvidence(sources, evaluations);

      return generateValidated(
        evidenceAssessmentSchema,
        evidencePrompt(question, accepted.sources, accepted.evaluations),
        options,
      );
    },
    generateReport(question, sources, evaluations, partial, options) {
      const accepted = selectAcceptedEvidence(sources, evaluations);

      return generateValidated(
        reportSchema,
        reportPrompt(
          question,
          accepted.sources,
          accepted.evaluations,
          partial,
        ),
        options,
        (output) => validateReportCitations(sources, evaluations, output),
      );
    },
  };
}
