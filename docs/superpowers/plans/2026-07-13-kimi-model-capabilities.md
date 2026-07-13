# Kimi Model Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `kimi-k2.6` structured generations through Kimi's native JSON Schema response format without changing DeepSeek or timeout behavior.

**Architecture:** Add a small typed registry keyed by provider and model ID, with conservative defaults for unknown models. The Kimi provider reads the registry and passes the resolved `structuredOutputs` capability into the existing OpenAI-compatible adapter; protocol conversion remains owned by AI SDK.

**Tech Stack:** TypeScript, Next.js 16.2, AI SDK 6, `@ai-sdk/openai-compatible`, Vitest, Zod

---

## File Structure

- Create `lib/providers/model-capabilities.ts`: define provider/model capability types, the verified registry, and conservative lookup.
- Create `lib/providers/model-capabilities.test.ts`: verify known-model and unknown-model behavior independently from environment/provider creation.
- Modify `lib/providers/index.ts`: resolve the Kimi model once and pass its registered structured-output capability to AI SDK.
- Modify `lib/providers/index.test.ts`: lock down default Kimi, overridden Kimi, and unchanged DeepSeek adapter configuration.
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

### Task 3: Document and verify the completed integration

**Files:**
- Modify: `docs/architecture.md:162-166`

- [ ] **Step 1: Update the provider-boundary documentation**

Replace the first provider-boundary paragraph with:

```markdown
`ResearchModel` 把供应商能力压缩为四个领域操作：`generatePlan`、`evaluateSources`、`assessEvidence`、`generateReport`。`getResearchModel()` 按 `AI_PROVIDER` 创建 Kimi 或 DeepSeek 的 OpenAI-compatible model；模型能力注册表按 `provider:model` 保存已经验证的协议能力，未知模型采用保守默认值。当前只有 `kimi:k2.6` 注册原生 Structured Output，DeepSeek 配置保持不变。只有无法由能力标记表达的协议差异才应引入 provider strategy，避免重复 AI SDK 已有的请求和响应转换。
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
