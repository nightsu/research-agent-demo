import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TavilyError, extractSources, searchWeb } from "./tavily";

const API_KEY = "test-tavily-secret";
const DEFAULT_BASE_URL = "https://api.tavily.com";
const articleUrl = "https://example.com/article";

const searchResponse = {
  results: [
    {
      title: "Agent tools",
      url: articleUrl,
      content: "A concise search result.",
      score: 0.91,
      published_date: "2026-02-03",
    },
  ],
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function expectTavilyError(error: unknown): asserts error is TavilyError {
  expect(error).toBeInstanceOf(TavilyError);
  if (!(error instanceof TavilyError)) {
    throw new TypeError("Expected TavilyError");
  }
}

describe("Tavily tools", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    process.env.TAVILY_API_KEY = API_KEY;
    delete process.env.TAVILY_BASE_URL;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    vi.unstubAllGlobals();
  });

  it("searches with the documented defaults, time range, authorization, and signal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse));
    const controller = new AbortController();

    await searchWeb("agent tools", { timeRange: "year" }, controller.signal);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${DEFAULT_BASE_URL}/search`);
    expect(init).toMatchObject({
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "agent tools",
      search_depth: "basic",
      time_range: "year",
      max_results: 6,
      include_answer: false,
      include_raw_content: false,
    });
  });

  it("omits the all time range and honors a base URL override", async () => {
    process.env.TAVILY_BASE_URL = "https://tavily.internal/v1/";
    fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse));

    await searchWeb("agent tools", { timeRange: "all" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://tavily.internal/v1/search");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("time_range");
  });

  it("normalizes validated search results into stable sources", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse));

    const result = await searchWeb("agent tools", { timeRange: "month" });

    expect(result).toEqual([
      {
        id: "source-11741d0bc7",
        title: "Agent tools",
        url: articleUrl,
        domain: "example.com",
        snippet: "A concise search result.",
        score: 0.91,
        publishedAt: "2026-02-03",
      },
    ]);
  });

  it("extracts markdown content into a URL-keyed map", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [{ url: articleUrl, raw_content: "# Extracted article" }],
      }),
    );
    const controller = new AbortController();

    const result = await extractSources(
      [articleUrl],
      "What does this say about agent tools?",
      controller.signal,
    );

    expect(result).toEqual(new Map([[articleUrl, "# Extracted article"]]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${DEFAULT_BASE_URL}/extract`);
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      urls: [articleUrl],
      query: "What does this say about agent tools?",
      chunks_per_source: 3,
      extract_depth: "basic",
      format: "markdown",
      include_images: false,
    });
  });

  it("fails before fetching when the API key is missing", async () => {
    delete process.env.TAVILY_API_KEY;

    const error = await searchWeb("agent tools", { timeRange: "week" }).catch(
      (cause: unknown) => cause,
    );

    expectTavilyError(error);
    expect(error).toMatchObject({ recoverable: false, status: undefined });
    expect(error.message).toContain("TAVILY_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])("classifies HTTP %i errors without leaking secrets or response bodies", async (
    status,
    recoverable,
  ) => {
    fetchMock.mockResolvedValueOnce(
      new Response(`request rejected; key=${API_KEY}`, { status }),
    );

    const error = await searchWeb("agent tools", { timeRange: "year" }).catch(
      (cause: unknown) => cause,
    );

    expectTavilyError(error);
    expect(error).toMatchObject({ status, recoverable });
    expect(error.message).toContain("/search");
    expect(error.message).toContain(String(status));
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain("request rejected");
  });

  it.each([
    ["invalid JSON", new Response("not-json")],
    [
      "invalid response shape",
      jsonResponse({ results: [{ title: "Missing URL" }] }),
    ],
    [
      "unsafe source URL",
      jsonResponse({
        results: [
          {
            title: "Unsafe",
            url: "file:///etc/passwd",
            content: "Unsafe result",
          },
        ],
      }),
    ],
  ])(
    "reports a useful non-recoverable validation error for %s",
    async (_label, response) => {
      fetchMock.mockResolvedValueOnce(response);

      const error = await searchWeb("agent tools", { timeRange: "year" }).catch(
        (cause: unknown) => cause,
      );

      expectTavilyError(error);
      expect(error.recoverable).toBe(false);
      expect(error.message).toContain("/search");
      expect(error.message.toLowerCase()).toMatch(/response|valid|json/);
      expect(error.cause).toBeDefined();
    },
  );

  it("rejects invalid inputs before fetching", async () => {
    const blankSearch = searchWeb("   ", { timeRange: "year" });
    const unsafeExtract = extractSources(
      ["javascript:alert(1)"],
      "Explain this source",
    );

    await expect(blankSearch).rejects.toMatchObject({ recoverable: false });
    await expect(unsafeExtract).rejects.toMatchObject({ recoverable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes AbortSignal unchanged and rethrows AbortError without relabeling it", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted", "AbortError");
    fetchMock.mockRejectedValueOnce(abortError);

    const operation = searchWeb(
      "agent tools",
      { timeRange: "year" },
      controller.signal,
    );

    await expect(operation).rejects.toBe(abortError);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});
