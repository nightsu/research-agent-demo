export type ProviderName = "kimi" | "deepseek";

export type ThinkingMode = "enabled" | "disabled";

export type ModelCapabilities = Readonly<{
  structuredOutputs: boolean;
  thinkingMode: ThinkingMode;
}>;

type ModelKey = `${ProviderName}:${string}`;

const CONSERVATIVE_DEFAULT: ModelCapabilities = Object.freeze({
  structuredOutputs: false,
  thinkingMode: "enabled",
});

const MODEL_CAPABILITIES: Readonly<
  Partial<Record<ModelKey, ModelCapabilities>>
> = Object.freeze({
  "kimi:kimi-k2.6": Object.freeze({
    structuredOutputs: false,
    thinkingMode: "disabled",
  }),
});

export function getModelCapabilities(
  providerName: ProviderName,
  modelId: string,
): ModelCapabilities {
  return MODEL_CAPABILITIES[`${providerName}:${modelId}`] ?? CONSERVATIVE_DEFAULT;
}
