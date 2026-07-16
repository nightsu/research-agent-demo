import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAICompatible, getModelCapabilities } = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn(),
  getModelCapabilities: vi.fn(),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
vi.mock("./model-capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-capabilities")>();
  getModelCapabilities.mockImplementation(actual.getModelCapabilities);

  return { ...actual, getModelCapabilities };
});

const originalEnv = { ...process.env };

describe("research provider selection", () => {
  beforeEach(() => {
    vi.resetModules();
    createOpenAICompatible.mockReset();
    getModelCapabilities.mockClear();
    process.env = { ...originalEnv };
    delete process.env.AI_PROVIDER;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.KIMI_MODEL;
    delete process.env.KIMI_BASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.DEEPSEEK_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("uses Kimi and its defaults when no provider is configured", async () => {
    process.env.MOONSHOT_API_KEY = "kimi-key";
    const model = { provider: "kimi-model" };
    const provider = vi.fn(() => model);
    createOpenAICompatible.mockReturnValue(provider);

    const { getProviderName, getResearchModel, getResearchModelSelection } =
      await import("./index");

    expect(getProviderName()).toBe("kimi");
    expect(getResearchModelSelection()).toEqual({
      model,
      capabilities: {
        structuredOutputs: false,
        thinkingMode: "disabled",
      },
    });
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "kimi",
      apiKey: "kimi-key",
      baseURL: "https://api.moonshot.cn/v1",
      supportsStructuredOutputs: false,
      transformRequestBody: expect.any(Function),
    });
    const transformRequestBody = createOpenAICompatible.mock.calls[0][0]
      .transformRequestBody as (
      requestBody: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(transformRequestBody({ messages: [] })).toEqual({
      messages: [],
      thinking: { type: "disabled" },
    });
    expect(provider).toHaveBeenCalledWith("kimi-k2.6");

    createOpenAICompatible.mockClear();
    provider.mockClear();
    expect(getResearchModel()).toBe(model);
    expect(createOpenAICompatible).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledOnce();
  });

  it("uses DeepSeek and its defaults when selected", async () => {
    process.env.AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    const model = { provider: "deepseek-model" };
    const provider = vi.fn(() => model);
    createOpenAICompatible.mockReturnValue(provider);

    const { getProviderName, getResearchModelSelection } = await import(
      "./index"
    );

    expect(getProviderName()).toBe("deepseek");
    expect(getResearchModelSelection()).toEqual({
      model,
      capabilities: {
        structuredOutputs: false,
        thinkingMode: "enabled",
      },
    });
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "deepseek",
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com",
      supportsStructuredOutputs: false,
    });
    expect(provider).toHaveBeenCalledWith("deepseek-v4-flash");
  });

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
        transformRequestBody: expect.any(Function),
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
        supportsStructuredOutputs: false,
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

    const { getResearchModelSelection } = await import("./index");

    expect(getResearchModelSelection()).toEqual({
      model,
      capabilities: {
        structuredOutputs: false,
        thinkingMode: "enabled",
      },
    });
    expect(createOpenAICompatible).toHaveBeenCalledWith(expectedProviderOptions);
    if (providerName === "kimi") {
      const transformRequestBody = createOpenAICompatible.mock.calls[0][0]
        .transformRequestBody as (
        requestBody: Record<string, unknown>,
      ) => Record<string, unknown>;
      const requestBody = { messages: [] };

      expect(transformRequestBody(requestBody)).toBe(requestBody);
    }
    expect(provider).toHaveBeenCalledWith("override-model");
  });

  it("propagates a future native structured-output capability to the adapter", async () => {
    process.env.AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    process.env.DEEPSEEK_MODEL = "future-native-model";
    const capabilities = {
      structuredOutputs: true,
      thinkingMode: "enabled" as const,
    };
    getModelCapabilities.mockReturnValueOnce(capabilities);
    const model = { provider: "future-native-model" };
    const provider = vi.fn(() => model);
    createOpenAICompatible.mockReturnValue(provider);

    const { getResearchModelSelection } = await import("./index");

    const selection = getResearchModelSelection();

    expect(getModelCapabilities).toHaveBeenCalledOnce();
    expect(getModelCapabilities).toHaveBeenCalledWith(
      "deepseek",
      "future-native-model",
    );
    expect(selection).toEqual({ model, capabilities });
    expect(selection.capabilities).toBe(capabilities);
    expect(createOpenAICompatible).toHaveBeenCalledOnce();
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "deepseek",
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com",
      supportsStructuredOutputs: true,
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledWith("future-native-model");
  });

  it("returns frozen capabilities that cannot pollute a later selection", async () => {
    process.env.MOONSHOT_API_KEY = "kimi-key";
    const provider = vi.fn(() => ({ provider: "kimi-model" }));
    createOpenAICompatible.mockReturnValue(provider);
    const { getResearchModelSelection } = await import("./index");

    const firstSelection = getResearchModelSelection();

    expect(Object.isFrozen(firstSelection.capabilities)).toBe(true);
    expect(
      Reflect.set(
        firstSelection.capabilities as { structuredOutputs: boolean },
        "structuredOutputs",
        true,
      ),
    ).toBe(false);
    expect(getResearchModelSelection().capabilities).toEqual({
      structuredOutputs: false,
      thinkingMode: "disabled",
    });
  });

  it("rejects unsupported providers with a clear error", async () => {
    process.env.AI_PROVIDER = "unknown";
    const { getProviderName, getResearchModel, getResearchModelSelection } =
      await import("./index");

    expect(() => getProviderName()).toThrow(
      'Unsupported AI provider "unknown". Expected "kimi" or "deepseek".',
    );
    expect(() => getResearchModel()).toThrow(
      'Unsupported AI provider "unknown". Expected "kimi" or "deepseek".',
    );
    expect(() => getResearchModelSelection()).toThrow(
      'Unsupported AI provider "unknown". Expected "kimi" or "deepseek".',
    );
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it.each([
    ["kimi", "MOONSHOT_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
  ])("rejects %s before provider creation when %s is missing", async (
    providerName,
    apiKeyName,
  ) => {
    process.env.AI_PROVIDER = providerName;
    const { getResearchModel, getResearchModelSelection } = await import(
      "./index"
    );

    expect(() => getResearchModel()).toThrow(
      `${apiKeyName} is required for the ${providerName} research provider.`,
    );
    expect(() => getResearchModelSelection()).toThrow(
      `${apiKeyName} is required for the ${providerName} research provider.`,
    );
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });
});
