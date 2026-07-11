import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type ProviderName = "kimi" | "deepseek";

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
    const provider = createOpenAICompatible({
      name: "kimi",
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1",
    });

    return provider(process.env.KIMI_MODEL ?? "kimi-k2.6");
  }

  // This explicit workflow uses separate structured generations, so it does not
  // replay reasoning_content. A future autonomous DeepSeek tool-call loop must
  // preserve that provider field between assistant tool calls.
  const provider = createOpenAICompatible({
    name: "deepseek",
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  });

  return provider(process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash");
}
