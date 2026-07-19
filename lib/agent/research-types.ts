import { z } from "zod";

export const RESEARCH_TEXT_LIMITS = {
  id: 200,
  title: 500,
  short: 2_000,
  content: 200_000,
  listItems: 50,
  findings: 30,
} as const;
export const MAX_SEARCH_QUERY_CHARS = 500;
export const MAX_SOURCE_SNIPPET_CHARS = RESEARCH_TEXT_LIMITS.short;
export const searchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SEARCH_QUERY_CHARS);

export const researchPhaseSchema = z.enum([
  "planning",
  "searching",
  "evaluating",
  "synthesizing",
  "completed",
  "partial",
  "cancelled",
  "failed",
]);

export const researchInputSchema = z.object({
  question: z.string().trim().min(10).max(2_000),
  timeRange: z.enum(["all", "year", "month", "week"]).default("year"),
  depth: z.enum(["quick", "deep"]).default("quick"),
});

export const researchPlanRequestSchema = z.strictObject({
  action: z.literal("plan"),
  input: researchInputSchema,
});

export const researchPlanSchema = z.object({
  objective: z.string().min(1).max(RESEARCH_TEXT_LIMITS.short),
  subquestions: z.array(z.string().min(1).max(RESEARCH_TEXT_LIMITS.short)).min(1).max(6),
  searchQueries: z.array(searchQuerySchema).min(1).max(6),
});

export const researchExecuteRequestSchema = z.strictObject({
  action: z.literal("execute"),
  input: researchInputSchema,
  plan: researchPlanSchema,
});

export const researchOperationRequestSchema = z.discriminatedUnion("action", [
  researchPlanRequestSchema,
  researchExecuteRequestSchema,
]);

export const httpUrlSchema = z.string().max(4_000).refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "URL must be valid and use the http: or https: protocol" },
);

export const sourceSchema = z.object({
  id: z.string().min(1).max(RESEARCH_TEXT_LIMITS.id),
  title: z.string().min(1).max(RESEARCH_TEXT_LIMITS.title),
  url: httpUrlSchema,
  domain: z.string().min(1).max(RESEARCH_TEXT_LIMITS.title),
  snippet: z.string().max(MAX_SOURCE_SNIPPET_CHARS),
  rawContent: z.string().max(RESEARCH_TEXT_LIMITS.content).optional(),
  publishedAt: z.string().max(RESEARCH_TEXT_LIMITS.id).optional(),
  score: z.number().min(0).max(1).optional(),
});

export const sourceEvaluationSchema = z.object({
  sourceId: z.string().trim().min(1).max(RESEARCH_TEXT_LIMITS.id),
  decision: z.enum(["accepted", "rejected"]),
  relevance: z.number().min(0).max(5),
  authority: z.number().min(0).max(5),
  freshness: z.number().min(0).max(5),
  reason: z.string().min(1).max(RESEARCH_TEXT_LIMITS.short),
});

export const evidenceAssessmentSchema = z.object({
  sufficient: z.boolean(),
  summary: z.string().min(1).max(RESEARCH_TEXT_LIMITS.short),
  gaps: z.array(z.string().max(RESEARCH_TEXT_LIMITS.short)).max(RESEARCH_TEXT_LIMITS.listItems),
  followUpQueries: z.array(searchQuerySchema).max(3),
});

export const reportSchema = z.object({
  title: z.string().max(RESEARCH_TEXT_LIMITS.title),
  executiveSummary: z.string().max(RESEARCH_TEXT_LIMITS.content),
  findings: z.array(
    z.object({
      claim: z.string().max(RESEARCH_TEXT_LIMITS.content),
      sourceIds: z.array(z.string().max(RESEARCH_TEXT_LIMITS.id)).min(1).max(RESEARCH_TEXT_LIMITS.listItems),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ).max(RESEARCH_TEXT_LIMITS.findings),
  trends: z.array(z.string().max(RESEARCH_TEXT_LIMITS.short)).max(RESEARCH_TEXT_LIMITS.listItems),
  disagreements: z.array(z.string().max(RESEARCH_TEXT_LIMITS.short)).max(RESEARCH_TEXT_LIMITS.listItems),
  limitations: z.array(z.string().max(RESEARCH_TEXT_LIMITS.short)).max(RESEARCH_TEXT_LIMITS.listItems),
});

export type ResearchPhase = z.infer<typeof researchPhaseSchema>;
export type ResearchRequest = z.input<typeof researchInputSchema>;
export type ResearchInput = z.infer<typeof researchInputSchema>;
export type ResearchPlanRequest = z.infer<typeof researchPlanRequestSchema>;
export type ResearchPlan = z.infer<typeof researchPlanSchema>;
export type ResearchExecuteRequest = z.infer<typeof researchExecuteRequestSchema>;
export type ResearchOperationRequest = z.infer<typeof researchOperationRequestSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SourceEvaluation = z.infer<typeof sourceEvaluationSchema>;
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;
export type ResearchReport = z.infer<typeof reportSchema>;
