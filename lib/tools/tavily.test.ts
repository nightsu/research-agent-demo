import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TavilyError, extractSources, searchWeb } from "./tavily";
import { MAX_SOURCE_SNIPPET_CHARS } from "../agent/research-types";

const API_KEY = "test-tavily-secret";
const SENTINEL = "do-not-retain-this-value";
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

  it.each([
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])("allows the loopback HTTP base URL %s", async (baseUrl) => {
    process.env.TAVILY_BASE_URL = baseUrl;
    fetchMock.mockResolvedValueOnce(jsonResponse(searchResponse));

    await searchWeb("agent tools", { timeRange: "all" });

    expect(fetchMock.mock.calls[0][0]).toBe(`${baseUrl}/search`);
  });

  it.each([
    ["remote HTTP", "http://example.com"],
    ["credentials", `https://${SENTINEL}:password@example.com`],
    ["unsupported protocol", "ftp://example.com"],
  ])("rejects a base URL with %s before fetching", async (_label, baseUrl) => {
    process.env.TAVILY_BASE_URL = baseUrl;

    const error = await searchWeb("agent tools", { timeRange: "all" }).catch(
      (cause: unknown) => cause,
    );

    expectTavilyError(error);
    expect(error).toMatchObject({ recoverable: false });
    expect(error.message).toContain("base URL");
    const errorSurface = [
      error.message,
      String(error.cause),
      JSON.stringify(error),
      JSON.stringify(error.cause),
    ].join(" ");
    expect(errorSurface).not.toContain(API_KEY);
    expect(errorSurface).not.toContain(SENTINEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", {}],
    ["unknown time range", { timeRange: SENTINEL }],
  ])("rejects %s search options with a controlled error before fetching", async (
    _label,
    options,
  ) => {
    const error = await searchWeb("agent tools", options as never).catch(
      (cause: unknown) => cause,
    );

    expectTavilyError(error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ recoverable: false });
    expect(error.message).toContain("options");
    expect(error.cause).toMatchObject({
      name: "Error",
      message: "Tavily search options validation failed",
    });
    expect(`${String(error.cause)} ${JSON.stringify(error.cause)}`).not.toContain(
      SENTINEL,
    );
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each([2_001, 50_000])(
    "truncates a validated %i-character provider snippet to the domain cap",
    async (length) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        results: [{
          title: "Long result",
          url: articleUrl,
          content: "x".repeat(length),
        }],
      }));

      const [result] = await searchWeb("agent tools", { timeRange: "all" });

      expect(result.snippet).toBe("x".repeat(MAX_SOURCE_SNIPPET_CHARS));
      expect(result.snippet).toHaveLength(2_000);
    },
  );

  it("canonicalizes equivalent provider URLs before storing and hashing them", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "First form",
            url: " HTTPS://EXAMPLE.com:443/docs/#first ",
            content: "First result",
          },
          {
            title: "Second form",
            url: "https://example.com/docs#second",
            content: "Second result",
          },
        ],
      }),
    );

    const result = await searchWeb("agent tools", { timeRange: "all" });

    expect(result).toHaveLength(2);
    expect(result.map((source) => source.url)).toEqual([
      "https://example.com/docs",
      "https://example.com/docs",
    ]);
    expect(result[0].id).toBe(result[1].id);
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

  it("rejects malformed failed extraction results without retaining provider content", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [{ url: articleUrl, raw_content: "# Extracted article" }],
        failed_results: [
          { url: `javascript:${SENTINEL}`, error: API_KEY },
        ],
      }),
    );

    const error = await extractSources(
      [articleUrl],
      "What does this source say?",
    ).catch((cause: unknown) => cause);

    expectTavilyError(error);
    expect(error).toMatchObject({ recoverable: false });
    expect(error.message).toContain("/extract");
    const errorSurface = `${error.message} ${String(error.cause)} ${JSON.stringify(error)}`;
    expect(errorSurface).not.toContain(SENTINEL);
    expect(errorSurface).not.toContain(API_KEY);
  });

  it.each([
    {
      label: "search result count",
      path: "/search",
      response: () =>
        jsonResponse({
          results: Array.from({ length: 101 }, (_, index) => ({
            title: `Result ${index}`,
            url: `https://example.com/${index}`,
            content: "Result content",
          })),
        }),
      operation: () => searchWeb("agent tools", { timeRange: "all" }),
    },
    {
      label: "search title length",
      path: "/search",
      response: () =>
        jsonResponse({
          results: [
            {
              title: `${"x".repeat(501)}${SENTINEL}`,
              url: articleUrl,
              content: API_KEY,
            },
          ],
        }),
      operation: () => searchWeb("agent tools", { timeRange: "all" }),
    },
    {
      label: "search content length",
      path: "/search",
      response: () =>
        jsonResponse({
          results: [
            {
              title: "Oversized content",
              url: articleUrl,
              content: `${"x".repeat(50_001)}${SENTINEL}${API_KEY}`,
            },
          ],
        }),
      operation: () => searchWeb("agent tools", { timeRange: "all" }),
    },
    {
      label: "extracted content length",
      path: "/extract",
      response: () =>
        jsonResponse({
          results: [
            {
              url: articleUrl,
              raw_content: `${"x".repeat(200_001)}${SENTINEL}${API_KEY}`,
            },
          ],
        }),
      operation: () =>
        extractSources([articleUrl], "What does this source say?"),
    },
    {
      label: "failed extraction count",
      path: "/extract",
      response: () =>
        jsonResponse({
          results: [],
          failed_results: Array.from({ length: 101 }, (_, index) => ({
            url: `https://example.com/${index}`,
            error: "Extraction failed",
          })),
        }),
      operation: () =>
        extractSources([articleUrl], "What does this source say?"),
    },
  ])("rejects an oversized $label response without leaking it", async ({
    path,
    response,
    operation,
  }) => {
    fetchMock.mockResolvedValueOnce(response());

    const error = await operation().catch((cause: unknown) => cause);

    expectTavilyError(error);
    expect(error).toMatchObject({ recoverable: false });
    expect(error.message).toContain(path);
    const errorSurface = `${error.message} ${String(error.cause)} ${JSON.stringify(error)}`;
    expect(errorSurface).not.toContain(SENTINEL);
    expect(errorSurface).not.toContain(API_KEY);
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
    [408, true],
    [425, true],
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
    [
      "invalid JSON",
      () => new Response(`${SENTINEL}:${API_KEY}`),
      "Tavily /search invalid JSON",
    ],
    [
      "invalid response shape",
      () =>
        jsonResponse({
          results: [
            {
              title: SENTINEL,
              url: articleUrl,
              content: API_KEY,
              score: SENTINEL,
            },
          ],
        }),
      "Tavily /search invalid response shape",
    ],
    [
      "unsafe source URL",
      () =>
        jsonResponse({
          results: [
            {
              title: "Unsafe",
              url: `file:///${SENTINEL}`,
              content: API_KEY,
            },
          ],
        }),
      "Tavily /search invalid response shape",
    ],
  ])(
    "reports a useful non-recoverable validation error for %s",
    async (_label, createResponse, expectedCauseMessage) => {
      fetchMock.mockResolvedValueOnce(createResponse());

      const error = await searchWeb("agent tools", { timeRange: "year" }).catch(
        (cause: unknown) => cause,
      );

      expectTavilyError(error);
      expect(error.recoverable).toBe(false);
      expect(error.message).toContain("/search");
      expect(error.message.toLowerCase()).toMatch(/response|valid|json/);
      expect(error.cause).toMatchObject({
        name: "Error",
        message: expectedCauseMessage,
      });
      const errorSurface = [
        error.message,
        String(error.cause),
        JSON.stringify(error),
        JSON.stringify(error.cause),
      ].join(" ");
      expect(errorSurface).not.toContain(SENTINEL);
      expect(errorSurface).not.toContain(API_KEY);
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

  it.each([
    ["custom error", new Error("cancelled by caller")],
    ["timeout", new DOMException("deadline exceeded", "TimeoutError")],
  ])("rethrows the exact %s abort reason after a request has started", async (
    _label,
    reason,
  ) => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce((_input, init) => {
      const requestSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("fetch aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const operation = searchWeb(
      "agent tools",
      { timeRange: "year" },
      controller.signal,
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    await expect(operation).rejects.not.toBeInstanceOf(TavilyError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
