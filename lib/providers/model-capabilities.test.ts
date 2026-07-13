import { describe, expect, it } from "vitest";

import { getModelCapabilities } from "./model-capabilities";

describe("model capabilities", () => {
  it("enables structured outputs for Kimi K2.6", () => {
    expect(getModelCapabilities("kimi", "kimi-k2.6")).toEqual({
      structuredOutputs: true,
    });
  });

  it.each([
    ["kimi", "custom-model"],
    ["deepseek", "deepseek-v4-flash"],
  ] as const)(
    "uses conservative capabilities for %s:%s",
    (providerName, modelId) => {
      expect(getModelCapabilities(providerName, modelId)).toEqual({
        structuredOutputs: false,
      });
    },
  );
});
