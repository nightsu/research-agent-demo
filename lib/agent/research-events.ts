import { z } from "zod";

import {
  httpUrlSchema,
  reportSchema,
  researchPlanSchema,
  sourceEvaluationSchema,
  sourceSchema,
  RESEARCH_TEXT_LIMITS,
} from "./research-types";

const nonemptyStringSchema = z.string().trim().min(1).max(RESEARCH_TEXT_LIMITS.short);
export const MAX_ENCODED_EVENT_BYTES = 1_048_576;

// Observable events expose decisions and tool evidence for the learning UI.
// They intentionally never transport provider-private chain-of-thought fields.
export const researchEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("plan.started"),
    question: nonemptyStringSchema,
  }),
  z.strictObject({
    type: z.literal("progress.updated"),
    operationCount: z.number().int().nonnegative(),
    operationLimit: z.number().int().positive(),
    searchRounds: z.number().int().nonnegative(),
    searchRoundLimit: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("plan.completed"),
    plan: researchPlanSchema,
  }),
  z.strictObject({
    type: z.literal("search.started"),
    query: nonemptyStringSchema,
    reason: nonemptyStringSchema,
  }),
  z.strictObject({
    type: z.literal("search.completed"),
    query: nonemptyStringSchema,
    sources: sourceSchema.array().max(RESEARCH_TEXT_LIMITS.listItems),
    // Provider-returned count before any downstream source filtering.
    resultCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("source.read"),
    sourceId: nonemptyStringSchema,
    url: httpUrlSchema,
  }),
  z.strictObject({
    type: z.literal("source.evaluated"),
    evaluation: sourceEvaluationSchema,
  }),
  z.strictObject({
    type: z.literal("gap.detected"),
    description: nonemptyStringSchema,
    followUpQueries: nonemptyStringSchema.array().max(3),
  }),
  z.strictObject({
    type: z.literal("conclusion.updated"),
    summary: nonemptyStringSchema,
  }),
  z.strictObject({
    type: z.literal("report.started"),
    partial: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("report.completed"),
    report: reportSchema,
  }),
  z.strictObject({
    type: z.literal("research.partial"),
    report: reportSchema,
    reason: nonemptyStringSchema,
  }),
  z.strictObject({
    type: z.literal("research.cancelled"),
  }),
  z.strictObject({
    type: z.literal("research.failed"),
    message: nonemptyStringSchema.max(500),
    recoverable: z.boolean(),
  }),
]);

export type ResearchEvent = z.infer<typeof researchEventSchema>;

export function encodeEvent(event: ResearchEvent): string {
  const encoded = `${JSON.stringify(researchEventSchema.parse(event))}\n`;
  if (new TextEncoder().encode(encoded).byteLength > MAX_ENCODED_EVENT_BYTES) {
    throw new Error(`Research event exceeds maximum encoded event size of ${MAX_ENCODED_EVENT_BYTES} bytes`);
  }
  return encoded;
}

export function decodeEventLine(line: string): ResearchEvent {
  const record = line.replace(/\r?\n$/, "");

  if (record.trim().length === 0 || /[\r\n]/.test(record)) {
    throw new Error("Expected exactly one non-blank event record");
  }

  return researchEventSchema.parse(JSON.parse(record));
}
