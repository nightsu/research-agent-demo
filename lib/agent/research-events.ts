import { z } from "zod";

import {
  reportSchema,
  researchPlanSchema,
  sourceEvaluationSchema,
  sourceSchema,
} from "./research-types";

const nonemptyStringSchema = z.string().trim().min(1);

// Observable events expose decisions and tool evidence for the learning UI.
// They intentionally never transport provider-private chain-of-thought fields.
export const researchEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("plan.started"),
    question: z.string(),
  }),
  z.object({
    type: z.literal("plan.completed"),
    plan: researchPlanSchema,
  }),
  z.object({
    type: z.literal("search.started"),
    query: nonemptyStringSchema,
    reason: nonemptyStringSchema,
  }),
  z.object({
    type: z.literal("search.completed"),
    query: nonemptyStringSchema,
    sources: sourceSchema.array(),
    resultCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("source.read"),
    sourceId: nonemptyStringSchema,
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("source.evaluated"),
    evaluation: sourceEvaluationSchema,
  }),
  z.object({
    type: z.literal("gap.detected"),
    description: nonemptyStringSchema,
    followUpQueries: nonemptyStringSchema.array().max(3),
  }),
  z.object({
    type: z.literal("conclusion.updated"),
    summary: nonemptyStringSchema,
  }),
  z.object({
    type: z.literal("report.started"),
    partial: z.boolean(),
  }),
  z.object({
    type: z.literal("report.completed"),
    report: reportSchema,
  }),
  z.object({
    type: z.literal("research.partial"),
    report: reportSchema,
    reason: nonemptyStringSchema,
  }),
  z.object({
    type: z.literal("research.cancelled"),
  }),
  z.object({
    type: z.literal("research.failed"),
    message: nonemptyStringSchema,
    recoverable: z.boolean(),
  }),
]);

export type ResearchEvent = z.infer<typeof researchEventSchema>;

export function encodeEvent(event: ResearchEvent): string {
  return `${JSON.stringify(researchEventSchema.parse(event))}\n`;
}

export function decodeEventLine(line: string): ResearchEvent {
  const record = line.replace(/\r?\n$/, "");

  if (record.trim().length === 0 || /[\r\n]/.test(record)) {
    throw new Error("Expected exactly one non-blank event record");
  }

  return researchEventSchema.parse(JSON.parse(record));
}
