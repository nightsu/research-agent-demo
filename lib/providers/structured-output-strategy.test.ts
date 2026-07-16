import { describe, expect, it } from "vitest";
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import { Output, streamText } from "ai";
import { toJSONSchema } from "zod";

import { reportSchema } from "../agent/research-types";

const report = {
  title: "Adapter request",
  executiveSummary: "The intercepted response is valid JSON.",
  findings: [],
  trends: [],
  disagreements: [],
  limitations: [],
};

function createFetchHarness() {
  let requestBody: Record<string, unknown> | undefined;
  const content = JSON.stringify(report);
  const sse = [
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  const interceptedFetch: NonNullable<
    OpenAICompatibleProviderSettings["fetch"]
  > = async (_input, init) => {
    expect(typeof init?.body).toBe("string");
    requestBody = JSON.parse(init?.body as string) as Record<string, unknown>;

    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  return {
    interceptedFetch,
    getRequestBody() {
      expect(requestBody).toBeDefined();
      return requestBody as Record<string, unknown>;
    },
  };
}

describe("AI SDK structured output transport", () => {
  it("describes Output.object as JSON with the exact report schema", async () => {
    const output = Output.object({ schema: reportSchema });

    await expect(output.responseFormat).resolves.toEqual({
      type: "json",
      schema: toJSONSchema(reportSchema, { target: "draft-7" }),
    });
  });

  it("sends json_schema through a native structured-output adapter", async () => {
    const harness = createFetchHarness();
    const provider = createOpenAICompatible({
      name: "native-test",
      apiKey: "not-sent",
      baseURL: "https://intercepted.invalid/v1",
      supportsStructuredOutputs: true,
      fetch: harness.interceptedFetch,
    });
    const result = streamText({
      model: provider("test-model"),
      prompt: "Return the report JSON.",
      output: Output.object({ schema: reportSchema }),
    });

    await expect(result.output).resolves.toEqual(report);

    expect(harness.getRequestBody().response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: toJSONSchema(reportSchema, { target: "draft-7" }),
      },
    });
  });

  it("sends schema-free json_object through a prompted JSON adapter", async () => {
    const harness = createFetchHarness();
    const provider = createOpenAICompatible({
      name: "prompted-test",
      apiKey: "not-sent",
      baseURL: "https://intercepted.invalid/v1",
      supportsStructuredOutputs: false,
      fetch: harness.interceptedFetch,
    });
    const result = streamText({
      model: provider("test-model"),
      prompt: "Return the report JSON.",
      output: Output.json(),
    });

    await expect(result.output).resolves.toEqual(report);

    const responseFormat = harness.getRequestBody().response_format;
    expect(responseFormat).toEqual({ type: "json_object" });
    expect(responseFormat).not.toHaveProperty("json_schema");
  });
});
