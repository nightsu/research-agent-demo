import type { Source, SourceEvaluation } from "./research-types";

const decisionGuidance = [
  "Provide concise observable decision summaries only.",
  "Never provide hidden chain of thought or private reasoning.",
  "Prefer official or primary sources and recent evidence.",
].join("\n");

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sourceForEvaluation(source: Source) {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    domain: source.domain,
    snippet: source.snippet,
    rawContent: source.rawContent,
    publishedAt: source.publishedAt,
  };
}

function sourceForSynthesis(source: Source) {
  return {
    id: source.id,
    title: source.title,
    domain: source.domain,
    snippet: source.snippet,
    rawContent: source.rawContent,
    publishedAt: source.publishedAt,
  };
}

function evaluationForSynthesis(evaluation: SourceEvaluation) {
  return {
    sourceId: evaluation.sourceId,
    decision: evaluation.decision,
    relevance: evaluation.relevance,
    authority: evaluation.authority,
    freshness: evaluation.freshness,
    reason: evaluation.reason,
  };
}

export function planPrompt(question: string): string {
  return `${decisionGuidance}

Create a focused research plan for this question:
${question}

Return an objective, 1-6 non-overlapping subquestions, and 1-6 precise search queries. Search queries should prioritize official or primary documentation and recent material. Do not answer the research question yet.`;
}

export function sourceEvaluationPrompt(
  question: string,
  sources: Source[],
): string {
  return `${decisionGuidance}

Evaluate only the supplied sources against this research question:
${question}

Sources:
${serialize(sources.map(sourceForEvaluation))}

Return exactly one evaluation per source ID. Mark each accepted or rejected; score relevance, authority, and freshness from 0 to 5; and give a brief evidence-based reason. Do not invent source IDs or facts outside the supplied source content.`;
}

export function evidencePrompt(
  question: string,
  sources: Source[],
  evaluations: SourceEvaluation[],
): string {
  return `${decisionGuidance}

Assess whether the accepted evidence can answer this research question:
${question}

Source evidence:
${serialize(sources.map(sourceForSynthesis))}

Source evaluations:
${serialize(evaluations.map(evaluationForSynthesis))}

Return whether the evidence is sufficient, a brief observable summary, concrete gaps, and at most 3 targeted follow-up queries. Base the assessment only on supplied source IDs and evaluations.`;
}

export function reportPrompt(
  question: string,
  sources: Source[],
  evaluations: SourceEvaluation[],
  partial: boolean,
): string {
  return `${decisionGuidance}

Write a ${partial ? "partial" : "complete"} research report answering:
${question}

Source evidence:
${serialize(sources.map(sourceForSynthesis))}

Source evaluations:
${serialize(evaluations.map(evaluationForSynthesis))}

Return a title, concise executive summary, findings, trends, disagreements, and limitations. Every finding must cite one or more source IDs from the supplied evidence and include high, medium, or low confidence. Omit or weaken unsupported claims. ${partial ? "This is a partial report: clearly disclose evidence gaps in the executive summary and limitations." : "Clearly disclose any remaining evidence gaps in limitations."}`;
}
