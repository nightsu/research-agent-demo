import { generateText, Output } from "ai";
import type { ZodType } from "zod";

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
  evidencePrompt,
  planPrompt,
  reportPrompt,
  sourceEvaluationPrompt,
} from "../agent/prompts";
import { getResearchModel } from "./index";

export interface ResearchModel {
  generatePlan(question: string): Promise<ResearchPlan>;
  evaluateSources(
    question: string,
    sources: Source[],
  ): Promise<SourceEvaluation[]>;
  assessEvidence(
    question: string,
    sources: Source[],
    evaluations: SourceEvaluation[],
  ): Promise<EvidenceAssessment>;
  generateReport(
    question: string,
    sources: Source[],
    evaluations: SourceEvaluation[],
    partial: boolean,
  ): Promise<ResearchReport>;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function generateValidated<T>(
  schema: ZodType<T>,
  prompt: string,
): Promise<T> {
  const model = getResearchModel();

  const attempt = async (attemptPrompt: string): Promise<T> => {
    const result = await generateText({
      model,
      prompt: attemptPrompt,
      output: Output.object({ schema }),
    });

    if (result.output == null) {
      throw new Error("The model returned no structured output");
    }

    // Output.object validates the provider response, and this parse keeps the
    // application schema as the final boundary even for mocked or future SDK results.
    return schema.parse(result.output);
  };

  try {
    return await attempt(prompt);
  } catch (initialError) {
    // One repair generation handles transient malformed output without allowing
    // an unbounded model retry loop or silently relaxing the schema.
    const repairPrompt = `${prompt}

Repair instruction: the previous generation failed validation (${failureMessage(initialError)}). Generate the full response again and satisfy the exact structured output constraints. Do not discuss the failure.`;

    try {
      return await attempt(repairPrompt);
    } catch (repairError) {
      throw new Error(
        "Structured generation failed after one repair attempt",
        { cause: repairError },
      );
    }
  }
}

export function createResearchModel(): ResearchModel {
  return {
    generatePlan(question) {
      return generateValidated(researchPlanSchema, planPrompt(question));
    },
    evaluateSources(question, sources) {
      return generateValidated(
        sourceEvaluationSchema.array(),
        sourceEvaluationPrompt(question, sources),
      );
    },
    assessEvidence(question, sources, evaluations) {
      return generateValidated(
        evidenceAssessmentSchema,
        evidencePrompt(question, sources, evaluations),
      );
    },
    generateReport(question, sources, evaluations, partial) {
      return generateValidated(
        reportSchema,
        reportPrompt(question, sources, evaluations, partial),
      );
    },
  };
}
