import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchPlan, Source, SourceEvaluation } from "@/lib/agent/research-types";

export interface PrinterSource {
  source: Source;
  read: boolean;
  evaluation?: SourceEvaluation;
}

export type PrinterRecord =
  | { id: string; kind: "plan"; question: string; plan?: ResearchPlan; status: "running" | "complete" }
  | { id: string; kind: "search"; query: string; reason: string; status: "running" | "complete"; resultCount?: number; sources: PrinterSource[] }
  | { id: string; kind: "gap"; description: string; followUpQueries: string[] }
  | { id: string; kind: "conclusion"; summary: string }
  | { id: string; kind: "synthesis"; partial: boolean; status: "running" | "validating" | "repairing" | "complete" }
  | { id: string; kind: "terminal"; outcome: "cancelled" | "failed"; message: string; recoverable: boolean };

export function derivePrinterRecords(events: ResearchEvent[]): PrinterRecord[] {
  const records: PrinterRecord[] = [];

  // 事件日志是唯一事实来源；这里仅做可重放的展示投影，不能产生新的研究结论。
  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case "plan.started":
        records.push({ id: `plan-${index}`, kind: "plan", question: event.question, status: "running" });
        break;
      case "plan.completed": {
        const record = records.toReversed().find((item) => item.kind === "plan" && item.status === "running");
        if (record?.kind === "plan") {
          record.plan = event.plan;
          record.status = "complete";
        } else {
          records.push({ id: `plan-${index}`, kind: "plan", question: event.plan.objective, plan: event.plan, status: "complete" });
        }
        break;
      }
      case "search.started":
        records.push({ id: `search-${index}`, kind: "search", query: event.query, reason: event.reason, status: "running", sources: [] });
        break;
      case "search.completed": {
        // 同一 query 可能再次执行；反向匹配才能把结果写入最近的未完成批次。
        const record = records.toReversed().find((item) => item.kind === "search" && item.query === event.query && item.status === "running");
        const sources = event.sources.map((item) => ({ source: item, read: false }));
        if (record?.kind === "search") {
          record.status = "complete";
          record.resultCount = event.resultCount;
          record.sources = sources;
        } else {
          records.push({ id: `search-${index}`, kind: "search", query: event.query, reason: "Search results received", status: "complete", resultCount: event.resultCount, sources });
        }
        break;
      }
      case "source.read":
        updatePrinterSource(records, event.sourceId, (entry) => { entry.read = true; });
        break;
      case "source.evaluated":
        updatePrinterSource(records, event.evaluation.sourceId, (entry) => { entry.evaluation = event.evaluation; });
        break;
      case "gap.detected":
        records.push({ id: `gap-${index}`, kind: "gap", description: event.description, followUpQueries: event.followUpQueries });
        break;
      case "conclusion.updated":
        records.push({ id: `conclusion-${index}`, kind: "conclusion", summary: event.summary });
        break;
      case "report.started":
        records.push({ id: `synthesis-${index}`, kind: "synthesis", partial: event.partial, status: "running" });
        break;
      case "report.validating":
      case "report.repairing": {
        const record = records.toReversed().find(
          (item) => item.kind === "synthesis" && item.status !== "complete",
        );
        if (record?.kind === "synthesis") {
          record.status = event.type === "report.validating" ? "validating" : "repairing";
        }
        break;
      }
      case "report.completed":
      case "research.partial": {
        const record = records.toReversed().find((item) => item.kind === "synthesis" && item.status !== "complete");
        if (record?.kind === "synthesis") record.status = "complete";
        else records.push({ id: `synthesis-${index}`, kind: "synthesis", partial: event.type === "research.partial", status: "complete" });
        break;
      }
      case "research.cancelled":
        records.push({ id: `terminal-${index}`, kind: "terminal", outcome: "cancelled", message: "Research stopped before completion.", recoverable: true });
        break;
      case "research.failed":
        records.push({ id: `terminal-${index}`, kind: "terminal", outcome: "failed", message: event.message, recoverable: event.recoverable });
        break;
      case "progress.updated":
      case "plan.awaiting_approval":
      case "report.delta":
        break;
    }
  }
  return records;
}

function updatePrinterSource(
  records: PrinterRecord[],
  sourceId: string,
  update: (entry: PrinterSource) => void,
) {
  const batch = records.toReversed().find(
    (record) => record.kind === "search" && record.sources.some((entry) => entry.source.id === sourceId),
  );
  if (batch?.kind !== "search") return;
  const entry = batch.sources.find((item) => item.source.id === sourceId);
  // 未知来源宁可不展示，也不能补造一个看似可信的来源条目。
  if (entry) update(entry);
}
