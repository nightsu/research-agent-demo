import { describe, expect, it } from "vitest";

import { getModelCapabilities } from "./model-capabilities";

describe("model capabilities", () => {
  it("uses prompted JSON for Kimi K2.6", () => {
    expect(getModelCapabilities("kimi", "kimi-k2.6")).toEqual({
      structuredOutputs: false,
      thinkingMode: "disabled",
    });
  });

  it.each([
    ["kimi", "custom-model"],
    ["deepseek", "deepseek-v4-flash"],
    ["deepseek", "kimi-k2.6"],
  ] as const)(
    "uses conservative capabilities for %s:%s",
    (providerName, modelId) => {
      expect(getModelCapabilities(providerName, modelId)).toEqual({
        structuredOutputs: false,
        thinkingMode: "enabled",
      });
    },
  );
});
