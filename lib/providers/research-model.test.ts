import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  evidenceAssessmentSchema,
  reportSchema,
  researchPlanSchema,
  sourceEvaluationSchema,
  type ResearchPlan,
  type Source,
} from "../agent/research-types";
import {
  evidencePrompt,
  planPrompt,
  reportPrompt,
  sourceEvaluationPrompt,
} from "../agent/prompts";

const { generateText, getResearchModel, objectOutput } = vi.hoisted(() => ({
  generateText: vi.fn(),
  getResearchModel: vi.fn(),
  objectOutput: vi.fn(({ schema }) => ({ kind: "object", schema })),
}));

vi.mock("ai", () => ({
  generateText,
  Output: { object: objectOutput },
}));

vi.mock("./index", () => ({ getResearchModel }));

import { createResearchModel } from "./research-model";

const question = "How do Kimi and DeepSeek research workflows compare?";
const selectedModel = { modelId: "selected-model" };
const plan: ResearchPlan = {
  objective: "Compare the workflows",
  subquestions: ["How does each workflow collect evidence?"],
  searchQueries: ["Kimi DeepSeek research workflow documentation"],
};
const sources: Source[] = [
  {
    id: "source-kimi",
    title: "Kimi documentation",
    url: "https://example.com/kimi",
    domain: "example.com",
    snippet: "Official workflow documentation",
    rawContent: "Kimi uses structured research stages.",
    publishedAt: "2026-06-01",
    score: 0.98,
  },
  {
    id: "source-deepseek",
    title: "DeepSeek documentation",
    url: "https://example.com/deepseek",
    domain: "example.com",
    snippet: "Official reasoning model documentation",
  },
];
const evaluations = sources.map((source) => ({
  sourceId: source.id,
  decision: "accepted" as const,
  relevance: 5,
  authority: 5,
  freshness: 4,
  reason: "Direct primary evidence",
}));
const evidence = {
  sufficient: true,
  summary: "The primary sources cover both workflows.",
  gaps: [],
  followUpQueries: [],
};
const report = {
  title: "Research workflow comparison",
  executiveSummary: "The workflows use explicit evidence stages.",
  findings: [
    {
      claim: "Kimi uses structured research stages.",
      sourceIds: ["source-kimi"],
      confidence: "high" as const,
    },
  ],
  trends: [],
  disagreements: [],
  limitations: [],
};

describe("structured research model", () => {
  beforeEach(() => {
    generateText.mockReset();
    getResearchModel.mockReset().mockReturnValue(selectedModel);
    objectOutput.mockClear();
  });

  it.each([
    {
      method: "generatePlan" as const,
      output: plan,
      schema: researchPlanSchema,
      promptFragments: [question],
    },
    {
      method: "evaluateSources" as const,
      output: evaluations,
      schema: sourceEvaluationSchema.array(),
      promptFragments: [question, "source-kimi", "source-deepseek"],
    },
    {
      method: "assessEvidence" as const,
      output: evidence,
      schema: evidenceAssessmentSchema,
      promptFragments: [question, "source-kimi", "source-deepseek"],
    },
    {
      method: "generateReport" as const,
      output: report,
      schema: reportSchema,
      promptFragments: [question, "source-kimi", "source-deepseek"],
    },
  ])("$method uses the selected model, schema, and focused prompt", async ({
    method,
    output,
    schema,
    promptFragments,
  }) => {
    generateText.mockResolvedValueOnce({ output });
    const researchModel = createResearchModel();

    const result =
      method === "generatePlan"
        ? await researchModel.generatePlan(question)
        : method === "evaluateSources"
          ? await researchModel.evaluateSources(question, sources)
          : method === "assessEvidence"
            ? await researchModel.assessEvidence(question, sources, evaluations)
            : await researchModel.generateReport(
                question,
                sources,
                evaluations,
                true,
              );

    expect(result).toEqual(output);
    expect(getResearchModel).toHaveBeenCalledTimes(1);
    expect(objectOutput).toHaveBeenCalledTimes(1);
    const actualSchema = objectOutput.mock.calls[0][0].schema;
    if (method === "evaluateSources") {
      expect(actualSchema.element).toBe(sourceEvaluationSchema);
    } else {
      expect(actualSchema).toBe(schema);
    }
    expect(actualSchema.safeParse(output).success).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
    const request = generateText.mock.calls[0][0];
    expect(request.model).toBe(selectedModel);
    expect(request.output).toEqual({ kind: "object", schema: actualSchema });
    for (const fragment of promptFragments) {
      expect(request.prompt).toContain(fragment);
    }
  });

  it.each([
    ["provider failure", new Error("temporary provider failure")],
    ["schema validation failure", { output: { objective: "invalid" } }],
    ["missing output", { output: undefined }],
  ])("repairs once after a %s", async (_label, firstFailure) => {
    if (firstFailure instanceof Error) {
      generateText.mockRejectedValueOnce(firstFailure);
    } else {
      generateText.mockResolvedValueOnce(firstFailure);
    }
    generateText.mockResolvedValueOnce({ output: plan });

    const result = await createResearchModel().generatePlan(question);

    expect(result).toEqual(plan);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1][0].prompt).toContain(
      "Repair instruction: the previous generation failed validation",
    );
    expect(generateText.mock.calls[1][0].prompt).toContain(question);
  });

  it("rethrows after the single repair attempt and preserves the second cause", async () => {
    const firstError = new Error("initial provider failure");
    const repairError = new Error("repair provider failure");
    generateText
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(repairError);

    const operation = createResearchModel().generatePlan(question);

    await expect(operation).rejects.toMatchObject({
      message: "Structured generation failed after one repair attempt",
      cause: repairError,
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("keeps stage prompts focused on observable, source-backed decisions", () => {
    const prompts = [
      planPrompt(question),
      sourceEvaluationPrompt(question, sources),
      evidencePrompt(question, sources, evaluations),
      reportPrompt(question, sources, evaluations, true),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("concise observable decision summaries");
      expect(prompt).toContain("Never provide hidden chain of thought");
      expect(prompt).toContain("official or primary");
      expect(prompt).toContain("recent");
    }

    expect(sourceEvaluationPrompt(question, sources)).not.toContain('"score"');
    expect(evidencePrompt(question, sources, evaluations)).not.toContain('"url"');

    const finalPrompt = reportPrompt(question, sources, evaluations, true);
    expect(finalPrompt).toContain("Every finding must cite one or more source IDs");
    expect(finalPrompt).toContain("Omit or weaken unsupported claims");
    expect(finalPrompt).toContain("clearly disclose evidence gaps");
  });
});
