import { z } from "zod";

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

export const researchPlanSchema = z.object({
  objective: z.string().min(1),
  subquestions: z.array(z.string().min(1)).min(1).max(6),
  searchQueries: z.array(z.string().min(1)).min(1).max(6),
});

export const sourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  domain: z.string().min(1),
  snippet: z.string(),
  rawContent: z.string().optional(),
  publishedAt: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
});

export const sourceEvaluationSchema = z.object({
  sourceId: z.string().trim().min(1),
  decision: z.enum(["accepted", "rejected"]),
  relevance: z.number().min(0).max(5),
  authority: z.number().min(0).max(5),
  freshness: z.number().min(0).max(5),
  reason: z.string().min(1),
});

export const evidenceAssessmentSchema = z.object({
  sufficient: z.boolean(),
  summary: z.string().min(1),
  gaps: z.array(z.string()),
  followUpQueries: z.array(z.string()).max(3),
});

export const reportSchema = z.object({
  title: z.string(),
  executiveSummary: z.string(),
  findings: z.array(
    z.object({
      claim: z.string(),
      sourceIds: z.array(z.string()).min(1),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
  trends: z.array(z.string()),
  disagreements: z.array(z.string()),
  limitations: z.array(z.string()),
});

export type ResearchPhase = z.infer<typeof researchPhaseSchema>;
export type ResearchInput = z.infer<typeof researchInputSchema>;
export type ResearchPlan = z.infer<typeof researchPlanSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SourceEvaluation = z.infer<typeof sourceEvaluationSchema>;
export type EvidenceAssessment = z.infer<typeof evidenceAssessmentSchema>;
export type ResearchReport = z.infer<typeof reportSchema>;
