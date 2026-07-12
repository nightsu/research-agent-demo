import type { ResearchModel, ResearchModelOptions } from "../providers/research-model";
import type { extractSources, searchWeb } from "../tools/tavily";
import type {
  EvidenceAssessment,
  ResearchInput,
  ResearchPlan,
  ResearchReport,
  Source,
  SourceEvaluation,
} from "./research-types";

export const researchFlowInput: ResearchInput = {
  question: "比较 Kimi 与 DeepSeek 的 Agent 工具调用开发差异",
  timeRange: "year",
  depth: "quick",
};

export const researchFlowInitialQuery =
  "Kimi Agent 工具调用官方文档 DeepSeek function calling 对比";
export const researchFlowFollowUpQuery =
  "DeepSeek Agent tool calls function calling 官方文档";
export const researchFlowRejectedSourceId = "source-community-blog";
export const researchFlowAcceptedSourceIds = [
  "source-kimi-official",
  "source-deepseek-official",
] as const;

const kimiOfficial: Source = {
  id: researchFlowAcceptedSourceIds[0],
  title: "Kimi API tool calls 官方文档",
  url: "https://platform.moonshot.cn/docs/guide/use-kimi-api-to-complete-tool-calls",
  domain: "platform.moonshot.cn",
  snippet: "Kimi 通过 OpenAI 兼容的 tools 和 tool_choice 协议返回工具调用。",
  publishedAt: "2026-02-10",
  score: 0.99,
};

const communityBlog: Source = {
  id: researchFlowRejectedSourceId,
  title: "一篇第三方 Agent 对比博客",
  url: "https://blog.example.com/kimi-deepseek-agent-comparison",
  domain: "blog.example.com",
  snippet: "作者根据个人体验比较两个提供商。",
  publishedAt: "2026-03-01",
  score: 0.55,
};

const deepSeekOfficial: Source = {
  id: researchFlowAcceptedSourceIds[1],
  title: "DeepSeek Function Calling 官方文档",
  url: "https://api-docs.deepseek.com/guides/function_calling",
  domain: "api-docs.deepseek.com",
  snippet: "DeepSeek 将 function calling 作为 Chat API 的工具协议。",
  publishedAt: "2026-01-20",
  score: 0.98,
};

const duplicateKimi: Source = {
  ...kimiOfficial,
  id: "source-kimi-duplicate-result",
  url: `${kimiOfficial.url}/#request-schema`,
};

const plan: ResearchPlan = {
  objective: "比较 Kimi 与 DeepSeek 在 Agent 工具调用中的开发协议和提供商差异",
  subquestions: [
    "两者的工具调用协议如何表达？",
    "提供商接入和开发体验有哪些差异？",
  ],
  searchQueries: [researchFlowInitialQuery],
};

const report: ResearchReport = {
  title: "Kimi 与 DeepSeek Agent 工具调用开发对比",
  executiveSummary:
    "两者都提供结构化工具调用，但开发者需分别核对提供商的兼容边界与参数约束。",
  findings: [
    {
      claim: "Kimi 官方 API 使用 tools 协议描述工具并返回结构化调用。",
      sourceIds: [kimiOfficial.id],
      confidence: "high",
    },
    {
      claim: "DeepSeek 官方 Chat API 以 function calling 流程完成工具选择与参数传递。",
      sourceIds: [deepSeekOfficial.id],
      confidence: "high",
    },
  ],
  trends: ["两个提供商都向 OpenAI 风格的工具协议靠拢。"],
  disagreements: ["兼容层相似，但模型支持范围和严格模式约束不完全相同。"],
  limitations: ["本快速研究仅核对了两家官方工具调用文档。"],
};

type SearchCall = { query: string; timeRange: ResearchInput["timeRange"] };

function abortIfNeeded(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function accepted(sourceId: string, reason: string): SourceEvaluation {
  return {
    sourceId,
    decision: "accepted",
    relevance: 5,
    authority: 5,
    freshness: 4,
    reason,
  };
}

export interface ResearchFlowFixture {
  model: ResearchModel;
  searchWeb: typeof searchWeb;
  extractSources: typeof extractSources;
  modelCalls: string[];
  modelOperationCalls: string[];
  modelSignals: AbortSignal[];
  toolCalls: string[];
  searchCalls: SearchCall[];
  extractCalls: string[][];
  readonly planReleased: boolean;
  releasePlan(): void;
}

export function createResearchFlowFixture(
  options: { deferPlan?: boolean } = {},
): ResearchFlowFixture {
  const modelCalls: string[] = [];
  const modelOperationCalls: string[] = [];
  const modelSignals: AbortSignal[] = [];
  const toolCalls: string[] = [];
  const searchCalls: SearchCall[] = [];
  const extractCalls: string[][] = [];
  const evaluatedSourceIds = new Set<string>();
  let assessmentRound = 0;
  let planReleased = !options.deferPlan;
  let releaseDeferredPlan: (() => void) | undefined;

  const waitForPlanRelease = options.deferPlan
    ? new Promise<void>((resolve) => {
        releaseDeferredPlan = resolve;
      })
    : Promise.resolve();

  const beginModelOperation = (
    operation: string,
    modelOptions?: ResearchModelOptions,
  ) => {
    abortIfNeeded(modelOptions?.abortSignal);
    modelCalls.push(operation);
    if (modelOptions?.abortSignal) modelSignals.push(modelOptions.abortSignal);
    modelOptions?.onModelCall?.();
    modelOperationCalls.push(operation);
  };

  const model: ResearchModel = {
    async generatePlan(_question, modelOptions) {
      beginModelOperation("generatePlan", modelOptions);
      await waitForPlanRelease;
      abortIfNeeded(modelOptions?.abortSignal);
      return plan;
    },
    async evaluateSources(_question, sources, modelOptions) {
      beginModelOperation("evaluateSources", modelOptions);
      const freshSources = sources.filter(
        (source) => !evaluatedSourceIds.has(source.id),
      );
      freshSources.forEach((source) => evaluatedSourceIds.add(source.id));
      return freshSources.map((source): SourceEvaluation => {
        if (source.id === researchFlowRejectedSourceId) {
          return {
            sourceId: source.id,
            decision: "rejected",
            relevance: 3,
            authority: 1,
            freshness: 4,
            reason: "第三方博客缺少可核对的一手协议依据。",
          };
        }
        return accepted(source.id, "提供商官方文档直接描述工具调用协议。");
      });
    },
    async assessEvidence(_question, _sources, _evaluations, modelOptions) {
      beginModelOperation("assessEvidence", modelOptions);
      assessmentRound += 1;
      if (assessmentRound === 1) {
        return {
          sufficient: false,
          summary: "已有 Kimi 官方依据，但缺少 DeepSeek 官方协议依据。",
          gaps: ["缺少 DeepSeek 官方 function calling 说明"],
          followUpQueries: [researchFlowFollowUpQuery],
        } satisfies EvidenceAssessment;
      }
      return {
        sufficient: true,
        summary: "Kimi 与 DeepSeek 的官方协议依据均已收集。",
        gaps: [],
        followUpQueries: [],
      } satisfies EvidenceAssessment;
    },
    async generateReport(
      _question,
      _sources,
      _evaluations,
      partial,
      modelOptions,
    ) {
      beginModelOperation("generateReport", modelOptions);
      if (partial) throw new Error("The complete fixture must not synthesize a partial report");
      return report;
    },
  };

  const fakeSearchWeb: typeof searchWeb = async (query, searchOptions, signal) => {
    abortIfNeeded(signal);
    toolCalls.push("searchWeb");
    searchCalls.push({ query, timeRange: searchOptions.timeRange });
    if (query === researchFlowInitialQuery) return [kimiOfficial, communityBlog];
    if (query === researchFlowFollowUpQuery) {
      return [deepSeekOfficial, duplicateKimi];
    }
    throw new Error(`Unexpected fixture search query: ${query}`);
  };

  const fakeExtractSources: typeof extractSources = async (urls, _question, signal) => {
    abortIfNeeded(signal);
    toolCalls.push("extractSources");
    extractCalls.push([...urls]);
    return new Map(
      urls.map((url) => [
        url,
        url.includes("moonshot")
          ? "Kimi 官方文档：tools 、tool_choice 与 tool 消息构成工具调用循环。"
          : url.includes("deepseek")
            ? "DeepSeek 官方文档：Chat API 支持 function calling 和工具参数。"
            : "第三方博客内容。",
      ]),
    );
  };

  return {
    model,
    searchWeb: fakeSearchWeb,
    extractSources: fakeExtractSources,
    modelCalls,
    modelOperationCalls,
    modelSignals,
    toolCalls,
    searchCalls,
    extractCalls,
    get planReleased() {
      return planReleased;
    },
    releasePlan() {
      planReleased = true;
      releaseDeferredPlan?.();
    },
  };
}
