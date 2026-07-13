import type { ModelCapabilities } from "./model-capabilities";

export function createKimiRequestTransformer(
  capabilities: ModelCapabilities,
): (requestBody: Record<string, unknown>) => Record<string, unknown> {
  if (capabilities.thinkingMode === "enabled") {
    return (requestBody) => requestBody;
  }

  return (requestBody) => ({
    ...requestBody,
    thinking: { type: "disabled" },
  });
}
