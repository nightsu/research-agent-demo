import { describe, expect, it } from "vitest";

import { getModelCapabilities } from "./model-capabilities";

describe("model capabilities", () => {
  it("uses prompted JSON for Kimi K2.6", () => {
    const capabilities = getModelCapabilities("kimi", "kimi-k2.6");

    expect(capabilities).toEqual({
      structuredOutputs: false,
      thinkingMode: "disabled",
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
  });

  it("keeps the conservative default frozen across callers", () => {
    const capabilities = getModelCapabilities("deepseek", "unknown-model");

    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(
      Reflect.set(
        capabilities as { structuredOutputs: boolean },
        "structuredOutputs",
        true,
      ),
    ).toBe(false);
    expect(getModelCapabilities("deepseek", "unknown-model")).toBe(capabilities);
    expect(getModelCapabilities("deepseek", "unknown-model")).toEqual({
      structuredOutputs: false,
      thinkingMode: "enabled",
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
