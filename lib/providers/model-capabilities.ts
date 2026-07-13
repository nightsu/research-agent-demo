export type ProviderName = "kimi" | "deepseek";

export type ModelCapabilities = Readonly<{
  structuredOutputs: boolean;
}>;

type ModelKey = `${ProviderName}:${string}`;

const CONSERVATIVE_DEFAULT: ModelCapabilities = {
  structuredOutputs: false,
};

const MODEL_CAPABILITIES: Readonly<
  Partial<Record<ModelKey, ModelCapabilities>>
> = {
  "kimi:kimi-k2.6": { structuredOutputs: true },
};

export function getModelCapabilities(
  providerName: ProviderName,
  modelId: string,
): ModelCapabilities {
  return MODEL_CAPABILITIES[`${providerName}:${modelId}`] ?? CONSERVATIVE_DEFAULT;
}
