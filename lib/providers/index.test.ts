import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createOpenAICompatible } = vi.hoisted(() => ({
  createOpenAICompatible: vi.fn(),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

const originalEnv = { ...process.env };

describe("research provider selection", () => {
  beforeEach(() => {
    vi.resetModules();
    createOpenAICompatible.mockReset();
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

    const { getProviderName, getResearchModel } = await import("./index");

    expect(getProviderName()).toBe("kimi");
    expect(getResearchModel()).toBe(model);
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "kimi",
      apiKey: "kimi-key",
      baseURL: "https://api.moonshot.cn/v1",
    });
    expect(provider).toHaveBeenCalledWith("kimi-k2.6");
  });

  it("uses DeepSeek and its defaults when selected", async () => {
    process.env.AI_PROVIDER = "deepseek";
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    const model = { provider: "deepseek-model" };
    const provider = vi.fn(() => model);
    createOpenAICompatible.mockReturnValue(provider);

    const { getProviderName, getResearchModel } = await import("./index");

    expect(getProviderName()).toBe("deepseek");
    expect(getResearchModel()).toBe(model);
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "deepseek",
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com",
    });
    expect(provider).toHaveBeenCalledWith("deepseek-v4-flash");
  });

  it.each([
    {
      providerName: "kimi",
      apiKeyName: "MOONSHOT_API_KEY",
      baseUrlName: "KIMI_BASE_URL",
      modelName: "KIMI_MODEL",
    },
    {
      providerName: "deepseek",
      apiKeyName: "DEEPSEEK_API_KEY",
      baseUrlName: "DEEPSEEK_BASE_URL",
      modelName: "DEEPSEEK_MODEL",
    },
  ])("honors $providerName environment overrides", async ({
    providerName,
    apiKeyName,
    baseUrlName,
    modelName,
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
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: providerName,
      apiKey: "override-key",
      baseURL: "https://override.example/v1",
    });
    expect(provider).toHaveBeenCalledWith("override-model");
  });

  it("rejects unsupported providers with a clear error", async () => {
    process.env.AI_PROVIDER = "unknown";
    const { getProviderName, getResearchModel } = await import("./index");

    expect(() => getProviderName()).toThrow(
      'Unsupported AI provider "unknown". Expected "kimi" or "deepseek".',
    );
    expect(() => getResearchModel()).toThrow(
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
    const { getResearchModel } = await import("./index");

    expect(() => getResearchModel()).toThrow(
      `${apiKeyName} is required for the ${providerName} research provider.`,
    );
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });
});
