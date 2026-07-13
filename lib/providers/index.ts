import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import {
  getModelCapabilities,
  type ProviderName,
} from "./model-capabilities";

export type { ProviderName };

function requireApiKey(providerName: ProviderName, variableName: string): string {
  const apiKey = process.env[variableName];

  if (!apiKey) {
    throw new Error(
      `${variableName} is required for the ${providerName} research provider.`,
    );
  }

  return apiKey;
}

export function getProviderName(): ProviderName {
  const configured = process.env.AI_PROVIDER ?? "kimi";

  if (configured === "kimi" || configured === "deepseek") {
    return configured;
  }

  throw new Error(
    `Unsupported AI provider "${configured}". Expected "kimi" or "deepseek".`,
  );
}

export function getResearchModel() {
  const providerName = getProviderName();

  if (providerName === "kimi") {
    const modelId = process.env.KIMI_MODEL ?? "kimi-k2.6";
    const capabilities = getModelCapabilities("kimi", modelId);
    const provider = createOpenAICompatible({
      name: "kimi",
      apiKey: requireApiKey("kimi", "MOONSHOT_API_KEY"),
      baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1",
      supportsStructuredOutputs: capabilities.structuredOutputs,
    });

    return provider(modelId);
  }

  // This explicit workflow uses separate structured generations, so it does not
  // replay reasoning_content. A future autonomous DeepSeek tool-call loop must
  // preserve that provider field between assistant tool calls.
  const provider = createOpenAICompatible({
    name: "deepseek",
    apiKey: requireApiKey("deepseek", "DEEPSEEK_API_KEY"),
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  });

  return provider(process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash");
}
