# Kimi Model Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reliable Kimi structured generations through Prompted JSON Object mode with default thinking disabled, without changing DeepSeek or timeout behavior.

**Architecture:** Keep a typed registry keyed by provider and model ID, with conservative defaults for unknown models. Kimi uses JSON mode plus a focused non-thinking request transformer; the generation helper derives an exact JSON contract from the domain Zod schema, requests unstructured JSON through AI SDK, and applies Zod as the final shape boundary.

**Tech Stack:** TypeScript, Next.js 16.2, AI SDK 6, `@ai-sdk/openai-compatible`, Vitest, Zod

---

## File Structure

- Create `lib/providers/model-capabilities.ts`: define provider/model capability types, the verified registry, and conservative lookup.
- Create `lib/providers/model-capabilities.test.ts`: verify known-model and unknown-model behavior independently from environment/provider creation.
- Create `lib/providers/kimi-request-transformer.ts`: map verified Kimi thinking capabilities to a provider-specific request body without mutating input.
- Create `lib/providers/kimi-request-transformer.test.ts`: verify disabled-thinking injection and conservative pass-through behavior.
- Modify `lib/providers/index.ts`: resolve the Kimi model once and pass its registered structured-output capability to AI SDK.
- Modify `lib/providers/index.test.ts`: lock down default Kimi, overridden Kimi, and unchanged DeepSeek adapter configuration.
- Modify `lib/providers/research-model.ts`: append schema-derived JSON contracts, use `Output.json`, and wrap source-evaluation arrays in a top-level object.
- Modify `lib/providers/research-model.test.ts`: verify prompted JSON contracts, manual Zod parsing, repair reuse, and source-evaluation wrapping.
- Modify `docs/architecture.md`: document the model-specific capability boundary and conservative fallback.

### Task 1: Add the typed model capability registry

**Files:**
- Create: `lib/providers/model-capabilities.ts`
- Create: `lib/providers/model-capabilities.test.ts`

- [ ] **Step 1: Write the failing capability tests**

Create `lib/providers/model-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { getModelCapabilities } from "./model-capabilities";

describe("model capabilities", () => {
  it("enables structured output for the verified Kimi model", () => {
    expect(getModelCapabilities("kimi", "kimi-k2.6")).toEqual({
      structuredOutputs: true,
    });
  });

  it.each([
    ["kimi", "custom-kimi-model"],
    ["deepseek", "deepseek-v4-flash"],
  ] as const)("uses conservative capabilities for %s:%s", (provider, model) => {
    expect(getModelCapabilities(provider, model)).toEqual({
      structuredOutputs: false,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts
```

Expected: FAIL because `./model-capabilities` does not exist.

- [ ] **Step 3: Implement the minimal capability registry**

Create `lib/providers/model-capabilities.ts`:

```ts
export type ProviderName = "kimi" | "deepseek";

export type ModelCapabilities = Readonly<{
  structuredOutputs: boolean;
}>;

type ModelKey = `${ProviderName}:${string}`;

const conservativeCapabilities: ModelCapabilities = {
  structuredOutputs: false,
};

const modelCapabilities = {
  "kimi:kimi-k2.6": {
    structuredOutputs: true,
  },
} satisfies Partial<Record<ModelKey, ModelCapabilities>>;

export function getModelCapabilities(
  providerName: ProviderName,
  modelId: string,
): ModelCapabilities {
  const key: ModelKey = `${providerName}:${modelId}`;
  return modelCapabilities[key as keyof typeof modelCapabilities]
    ?? conservativeCapabilities;
}
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts
```

Expected: 1 test file passes with 3 test cases.

- [ ] **Step 5: Commit the registry**

```bash
git add lib/providers/model-capabilities.ts lib/providers/model-capabilities.test.ts
git diff --cached --check
git commit -m "feat: add model capability registry"
```

### Task 2: Apply registered capabilities to Kimi provider creation

**Files:**
- Modify: `lib/providers/index.ts:1-52`
- Modify: `lib/providers/index.test.ts:30-103`

- [ ] **Step 1: Update provider tests first**

In the default Kimi test, change the expected adapter options to:

```ts
expect(createOpenAICompatible).toHaveBeenCalledWith({
  name: "kimi",
  apiKey: "kimi-key",
  baseURL: "https://api.moonshot.cn/v1",
  supportsStructuredOutputs: true,
});
```

Replace the environment override cases with explicit expected adapter options so an unknown Kimi model is conservative while DeepSeek remains unchanged:

```ts
it.each([
  {
    providerName: "kimi",
    apiKeyName: "MOONSHOT_API_KEY",
    baseUrlName: "KIMI_BASE_URL",
    modelName: "KIMI_MODEL",
    expectedProviderOptions: {
      name: "kimi",
      apiKey: "override-key",
      baseURL: "https://override.example/v1",
      supportsStructuredOutputs: false,
    },
  },
  {
    providerName: "deepseek",
    apiKeyName: "DEEPSEEK_API_KEY",
    baseUrlName: "DEEPSEEK_BASE_URL",
    modelName: "DEEPSEEK_MODEL",
    expectedProviderOptions: {
      name: "deepseek",
      apiKey: "override-key",
      baseURL: "https://override.example/v1",
    },
  },
])("honors $providerName environment overrides", async ({
  providerName,
  apiKeyName,
  baseUrlName,
  modelName,
  expectedProviderOptions,
}) => {
  process.env.AI_PROVIDER = providerName;
  process.env[apiKeyName] = "override-key";
  process.env[baseUrlName] = "https://override.example/v1";
  process.env[modelName] = "override-model";
  const model = { provider: `${providerName}-model` };
  const provider = vi.fn(() => model);
  createOpenAICompatible.mockReturnValue(provider);

  const { getResearchModel } = await import("./index");

  expect(getResearchModel()).toBe(model);
  expect(createOpenAICompatible).toHaveBeenCalledWith(expectedProviderOptions);
  expect(provider).toHaveBeenCalledWith("override-model");
});
```

- [ ] **Step 2: Run the provider test to verify it fails for Kimi**

Run:

```bash
npm test -- --run lib/providers/index.test.ts
```

Expected: FAIL because Kimi creation does not yet pass `supportsStructuredOutputs`.

- [ ] **Step 3: Wire the registry into the Kimi branch**

At the top of `lib/providers/index.ts`, import the type and lookup:

```ts
import {
  getModelCapabilities,
  type ProviderName,
} from "./model-capabilities";
```

Remove the local `ProviderName` declaration and re-export the imported type:

```ts
export type { ProviderName } from "./model-capabilities";
```

Replace the Kimi branch with:

```ts
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
```

Do not add capability options to the DeepSeek branch.

- [ ] **Step 4: Run provider and model tests**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts lib/providers/index.test.ts lib/providers/research-model.test.ts
```

Expected: 3 test files pass; the default Kimi adapter enables structured outputs, an overridden unknown Kimi model disables them, and DeepSeek options remain unchanged.

- [ ] **Step 5: Commit Kimi provider wiring**

```bash
git add lib/providers/index.ts lib/providers/index.test.ts
git diff --cached --check
git commit -m "fix: enable Kimi structured output"
```

### Task 3: Disable Kimi thinking for bounded structured generations

**Files:**
- Modify: `lib/providers/model-capabilities.ts`
- Modify: `lib/providers/model-capabilities.test.ts`
- Create: `lib/providers/kimi-request-transformer.ts`
- Create: `lib/providers/kimi-request-transformer.test.ts`
- Modify: `lib/providers/index.ts`
- Modify: `lib/providers/index.test.ts`

- [ ] **Step 1: Extend the capability tests first**

Update the expected capability objects in `lib/providers/model-capabilities.test.ts`:

```ts
expect(getModelCapabilities("kimi", "kimi-k2.6")).toEqual({
  structuredOutputs: true,
  thinkingMode: "disabled",
});

expect(getModelCapabilities(providerName, modelId)).toEqual({
  structuredOutputs: false,
  thinkingMode: "enabled",
});
```

Keep the existing unknown Kimi, DeepSeek, and cross-provider `deepseek:kimi-k2.6` cases.

- [ ] **Step 2: Run the capability tests to verify they fail**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts
```

Expected: FAIL because `thinkingMode` is absent from the returned objects.

- [ ] **Step 3: Add the thinking capability**

Update `lib/providers/model-capabilities.ts`:

```ts
export type ProviderName = "kimi" | "deepseek";
export type ThinkingMode = "enabled" | "disabled";

export type ModelCapabilities = Readonly<{
  structuredOutputs: boolean;
  thinkingMode: ThinkingMode;
}>;

type ModelKey = `${ProviderName}:${string}`;

const CONSERVATIVE_DEFAULT: ModelCapabilities = {
  structuredOutputs: false,
  thinkingMode: "enabled",
};

const MODEL_CAPABILITIES: Readonly<
  Partial<Record<ModelKey, ModelCapabilities>>
> = {
  "kimi:kimi-k2.6": {
    structuredOutputs: true,
    thinkingMode: "disabled",
  },
};

export function getModelCapabilities(
  providerName: ProviderName,
  modelId: string,
): ModelCapabilities {
  return MODEL_CAPABILITIES[`${providerName}:${modelId}`] ?? CONSERVATIVE_DEFAULT;
}
```

- [ ] **Step 4: Run the capability tests to verify they pass**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts
```

Expected: the focused capability test file passes.

- [ ] **Step 5: Write failing Kimi request-transformer tests**

Create `lib/providers/kimi-request-transformer.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createKimiRequestTransformer } from "./kimi-request-transformer";

describe("Kimi request transformer", () => {
  it("injects disabled thinking without mutating the AI SDK request body", () => {
    const requestBody = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "Return a plan" }],
      response_format: { type: "json_schema" },
    };
    const transform = createKimiRequestTransformer({
      structuredOutputs: true,
      thinkingMode: "disabled",
    });

    expect(transform(requestBody)).toEqual({
      ...requestBody,
      thinking: { type: "disabled" },
    });
    expect(requestBody).not.toHaveProperty("thinking");
  });

  it("preserves the provider request for conservative models", () => {
    const requestBody = { model: "custom-model", messages: [] };
    const transform = createKimiRequestTransformer({
      structuredOutputs: false,
      thinkingMode: "enabled",
    });

    expect(transform(requestBody)).toBe(requestBody);
  });
});
```

- [ ] **Step 6: Run the transformer tests to verify they fail**

Run:

```bash
npm test -- --run lib/providers/kimi-request-transformer.test.ts
```

Expected: FAIL because `./kimi-request-transformer` does not exist.

- [ ] **Step 7: Implement the minimal Kimi request transformer**

Create `lib/providers/kimi-request-transformer.ts`:

```ts
import type { ModelCapabilities } from "./model-capabilities";

export function createKimiRequestTransformer(
  capabilities: ModelCapabilities,
) {
  return (requestBody: Record<string, unknown>): Record<string, unknown> => {
    if (capabilities.thinkingMode !== "disabled") return requestBody;

    return {
      ...requestBody,
      thinking: { type: "disabled" },
    };
  };
}
```

- [ ] **Step 8: Run capability and transformer tests**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts lib/providers/kimi-request-transformer.test.ts
```

Expected: both focused test files pass.

- [ ] **Step 9: Add failing provider wiring assertions**

In `lib/providers/index.test.ts`, add `transformRequestBody: expect.any(Function)` to both Kimi adapter expectations. After default Kimi creation, verify the captured transformer:

```ts
const defaultKimiOptions = createOpenAICompatible.mock.calls[0][0];
expect(defaultKimiOptions.transformRequestBody?.({ model: "kimi-k2.6" })).toEqual({
  model: "kimi-k2.6",
  thinking: { type: "disabled" },
});
```

For the overridden unknown Kimi case, invoke the captured transformer with a stable object and assert reference identity:

```ts
const providerOptions = createOpenAICompatible.mock.calls[0][0];
if (providerName === "kimi") {
  const requestBody = { model: "override-model" };
  expect(providerOptions.transformRequestBody?.(requestBody)).toBe(requestBody);
}
```

Keep the DeepSeek expectation exact and without `transformRequestBody`.

- [ ] **Step 10: Run provider tests to verify they fail**

Run:

```bash
npm test -- --run lib/providers/index.test.ts
```

Expected: FAIL because Kimi provider creation does not yet include a transformer.

- [ ] **Step 11: Wire the transformer into Kimi provider creation**

Import the transformer in `lib/providers/index.ts`:

```ts
import { createKimiRequestTransformer } from "./kimi-request-transformer";
```

Add the transformer to the existing Kimi `createOpenAICompatible` settings:

```ts
transformRequestBody: createKimiRequestTransformer(capabilities),
```

Do not add the transformer or thinking capability lookup to DeepSeek.

- [ ] **Step 12: Run focused and static verification**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts lib/providers/kimi-request-transformer.test.ts lib/providers/index.test.ts lib/providers/research-model.test.ts
npm run typecheck
npm run lint
git diff --check
```

Expected: all focused tests, typecheck, lint, and whitespace validation pass.

- [ ] **Step 13: Commit the thinking override**

```bash
git add lib/providers/model-capabilities.ts lib/providers/model-capabilities.test.ts lib/providers/kimi-request-transformer.ts lib/providers/kimi-request-transformer.test.ts lib/providers/index.ts lib/providers/index.test.ts
git diff --cached --check
git commit -m "fix: disable Kimi thinking for structured research"
```

### Task 4: Implement Prompted JSON Object generation

**Files:**
- Modify: `lib/providers/model-capabilities.ts`
- Modify: `lib/providers/model-capabilities.test.ts`
- Modify: `lib/providers/index.test.ts`
- Modify: `lib/providers/research-model.ts`
- Modify: `lib/providers/research-model.test.ts`

- [ ] **Step 1: Correct the verified Kimi capability test**

Change the known Kimi expectation in `lib/providers/model-capabilities.test.ts` to:

```ts
expect(getModelCapabilities("kimi", "kimi-k2.6")).toEqual({
  structuredOutputs: false,
  thinkingMode: "disabled",
});
```

Change the default Kimi adapter expectation in `lib/providers/index.test.ts` to `supportsStructuredOutputs: false`. Keep the disabled-thinking transformer assertion and all DeepSeek expectations unchanged.

- [ ] **Step 2: Run capability and provider tests to verify RED**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts lib/providers/index.test.ts
```

Expected: FAIL because the registered Kimi capability still reports native Structured Output support.

- [ ] **Step 3: Disable the overstated native capability**

Update the Kimi registry entry in `lib/providers/model-capabilities.ts`:

```ts
"kimi:kimi-k2.6": {
  structuredOutputs: false,
  thinkingMode: "disabled",
},
```

- [ ] **Step 4: Run capability and provider tests to verify GREEN**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts lib/providers/index.test.ts
```

Expected: both focused files pass; Kimi JSON mode and disabled thinking are independently represented.

- [ ] **Step 5: Write failing Prompted JSON Object tests**

In `lib/providers/research-model.test.ts`, replace the mocked `Output.object` helper with `Output.json`:

```ts
const { generateText, getResearchModel, jsonOutput } = vi.hoisted(() => ({
  generateText: vi.fn(),
  getResearchModel: vi.fn(),
  jsonOutput: vi.fn(() => ({ kind: "json" })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText,
    Output: { json: jsonOutput },
  };
});
```

Update the stage matrix so source evaluation's provider output is `{ evaluations }` while its public expected result remains `evaluations`. Other provider outputs and public results remain identical. Assert every request:

```ts
expect(request.output).toEqual({ kind: "json" });
expect(request.prompt).toContain("Return only one JSON object");
expect(request.prompt).toContain("Use the exact property names from this JSON Schema");
expect(request.prompt).toContain("Do not wrap the JSON in Markdown or add explanatory text");
expect(request.prompt.lastIndexOf("Output JSON Schema:"))
  .toBeGreaterThan(request.prompt.lastIndexOf("[END UNTRUSTED"));
```

For each stage, assert the contract contains its exact top-level keys:

```ts
const expectedKeys = {
  generatePlan: ["objective", "subquestions", "searchQueries"],
  evaluateSources: ["evaluations"],
  assessEvidence: ["sufficient", "summary", "gaps", "followUpQueries"],
  generateReport: ["title", "executiveSummary", "findings", "trends", "disagreements", "limitations"],
}[method];
for (const key of expectedKeys) expect(request.prompt).toContain(`"${key}"`);
```

Update every mocked successful or invalid source-evaluation provider output to use `{ evaluations: value }`, including malicious-source, oversized-source, and invalid-integrity cases. Keep public method results and integrity expectations as arrays.

Extend the existing repair test to assert both calls contain one schema contract and the repair call places it after the repair instruction:

```ts
for (const call of generateText.mock.calls) {
  expect(call[0].prompt.match(/Output JSON Schema:/g)).toHaveLength(1);
}
expect(generateText.mock.calls[1][0].prompt.lastIndexOf("Output JSON Schema:"))
  .toBeGreaterThan(
    generateText.mock.calls[1][0].prompt.indexOf("Repair instruction:"),
  );
```

- [ ] **Step 6: Run research-model tests to verify RED**

Run:

```bash
npm test -- --run lib/providers/research-model.test.ts
```

Expected: FAIL because the implementation still calls `Output.object`, does not append a schema contract, and expects a top-level evaluation array.

- [ ] **Step 7: Implement schema-derived Prompted JSON Object generation**

Update imports in `lib/providers/research-model.ts`:

```ts
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { toJSONSchema, z, ZodError, type ZodType } from "zod";
```

Wrap the evaluation transport shape:

```ts
const sourceEvaluationsSchema = sourceEvaluationSchema.array().max(50);
const sourceEvaluationsOutputSchema = z.object({
  evaluations: sourceEvaluationsSchema,
});
```

Add the shared contract helper before `generateValidated`:

```ts
function appendJsonContract<T>(prompt: string, schema: ZodType<T>): string {
  const contract = JSON.stringify(toJSONSchema(schema, { target: "draft-7" }));

  return `${prompt}

Return only one JSON object.
Use the exact property names from this JSON Schema.
Do not wrap the JSON in Markdown or add explanatory text.
Output JSON Schema:
${contract}`;
}
```

In each `attempt`, request JSON without transmitting a native schema and apply Zod locally:

```ts
const result = await generateText({
  model,
  system: RESEARCH_SYSTEM_PROMPT,
  prompt: appendJsonContract(attemptPrompt, schema),
  output: Output.json(),
  abortSignal: options.abortSignal,
  maxOutputTokens,
});

if (result.output == null) throw new MissingStructuredOutputError();
return validate(schema.parse(result.output));
```

Make `evaluateSources` async, generate the wrapper, preserve the existing integrity validator, and return the public array:

```ts
async evaluateSources(question, sources, options) {
  const output = await generateValidated(
    sourceEvaluationsOutputSchema,
    sourceEvaluationPrompt(question, sources),
    6_000,
    options,
    (value) => ({
      evaluations: validateSourceEvaluations(sources, value.evaluations),
    }),
  );

  return output.evaluations;
},
```

- [ ] **Step 8: Run focused tests and static checks**

Run:

```bash
npm test -- --run lib/providers/model-capabilities.test.ts lib/providers/index.test.ts lib/providers/research-model.test.ts
npm run typecheck
npm run lint
git diff --check
```

Expected: all focused tests, typecheck, lint, and whitespace validation pass. No AI SDK unsupported-response-format warning is produced by the unit tests because `Output.json()` carries no schema.

- [ ] **Step 9: Commit Prompted JSON Object support**

```bash
git add lib/providers/model-capabilities.ts lib/providers/model-capabilities.test.ts lib/providers/index.test.ts lib/providers/research-model.ts lib/providers/research-model.test.ts
git diff --cached --check
git commit -m "fix: prompt Kimi for schema-shaped JSON"
```

### Task 5: Document and verify the completed integration

**Files:**
- Modify: `docs/architecture.md:162-166`

- [ ] **Step 1: Update the provider-boundary documentation**

Replace the first provider-boundary paragraph with:

```markdown
`ResearchModel` 把供应商能力压缩为四个领域操作：`generatePlan`、`evaluateSources`、`assessEvidence`、`generateReport`。`getResearchModel()` 按 `AI_PROVIDER` 创建 Kimi 或 DeepSeek 的 OpenAI-compatible model；模型能力注册表按 `provider:model` 保存已经验证的协议能力，未知模型采用保守默认值。当前 `kimi:kimi-k2.6` 使用 Prompted JSON Object：Kimi request transformer 禁用默认 thinking，通用生成层从 Zod Schema 派生精确 JSON 合约并在本地完成最终校验；DeepSeek 配置保持不变。只有无法由能力标记表达的协议差异才应扩展 provider strategy，避免重复 AI SDK 已有的请求和响应转换。
```

- [ ] **Step 2: Run all static and automated verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build -- --webpack
git diff --check
```

Expected: 12 or more test files pass with no failures; typecheck and lint exit 0; Next.js production build succeeds; `git diff --check` is silent.

- [ ] **Step 3: Start the new production build on a free port**

Run in a persistent terminal:

```bash
npm start -- -p 3002
```

Expected: Next.js reports `Ready` and `http://localhost:3002`.

- [ ] **Step 4: Run a live Kimi quick-research smoke test**

Run in another terminal:

```bash
curl -N -sS -X POST http://localhost:3002/api/research \
  -H 'Content-Type: application/json' \
  -d '{"question":"What changed in browser rendering performance during the past year?","depth":"quick","timeRange":"year"}' \
  | tee /tmp/research-agent-kimi-smoke.ndjson
```

Expected:

- The stream contains `plan.completed` after the first model operation.
- The server does not print `The feature "responseFormat" is not supported`.
- The request advances into search events instead of ending immediately with `A research operation timed out.`
- A later partial result is acceptable if Tavily evidence or the total operation budget is insufficient; this smoke test specifically validates the Kimi structured planning boundary.

- [ ] **Step 5: Validate the captured event stream**

Run:

```bash
rg -n '"type":"plan.completed"|"type":"search.started"|"type":"research.failed"' /tmp/research-agent-kimi-smoke.ndjson
```

Expected: `plan.completed` and `search.started` are present; no initial planning `research.failed` event reports an operation timeout.

- [ ] **Step 6: Commit the architecture documentation**

```bash
git add docs/architecture.md
git diff --cached --check
git commit -m "docs: describe model capability registry"
```
