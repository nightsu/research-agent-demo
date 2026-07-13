import { describe, expect, it } from "vitest";

import type { ModelCapabilities } from "./model-capabilities";
import { createKimiRequestTransformer } from "./kimi-request-transformer";

describe("Kimi request transformer", () => {
  it("clones the request and disables thinking when configured", () => {
    const capabilities: ModelCapabilities = {
      structuredOutputs: true,
      thinkingMode: "disabled",
    };
    const requestBody = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "Research this topic" }],
      response_format: { type: "json_schema" },
      temperature: 0.2,
    };
    const originalBody = structuredClone(requestBody);

    const transformed = createKimiRequestTransformer(capabilities)(requestBody);

    expect(transformed).toEqual({
      ...requestBody,
      thinking: { type: "disabled" },
    });
    expect(transformed).not.toBe(requestBody);
    expect(requestBody).toEqual(originalBody);
  });

  it("returns the original request by reference when thinking is enabled", () => {
    const capabilities: ModelCapabilities = {
      structuredOutputs: false,
      thinkingMode: "enabled",
    };
    const requestBody = { model: "custom-model", messages: [] };

    const transformed = createKimiRequestTransformer(capabilities)(requestBody);

    expect(transformed).toBe(requestBody);
  });
});
