import { createHash } from "node:crypto";

import { z } from "zod";

import {
  httpUrlSchema,
  sourceSchema,
  type Source,
} from "../agent/research-types";

const DEFAULT_BASE_URL = "https://api.tavily.com";

const querySchema = z.string().trim().min(1).max(500);
const questionSchema = z.string().trim().min(1).max(2_000);
const inputUrlSchema = z.string().max(2_048).pipe(httpUrlSchema);
const inputUrlsSchema = z.array(inputUrlSchema).min(1).max(20);

const tavilySearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().min(1),
      url: httpUrlSchema,
      content: z.string(),
      score: z.number().min(0).max(1).optional(),
      published_date: z.string().nullable().optional(),
    }),
  ),
});

const tavilyExtractResponseSchema = z.object({
  results: z.array(
    z.object({
      url: httpUrlSchema,
      raw_content: z.string(),
    }),
  ),
});

type TavilyErrorOptions = {
  recoverable: boolean;
  status?: number;
  cause?: unknown;
};

export class TavilyError extends Error {
  readonly recoverable: boolean;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(message: string, options: TavilyErrorOptions) {
    super(message);
    this.name = "TavilyError";
    this.recoverable = options.recoverable;
    this.status = options.status;
    this.cause = options.cause;
  }
}

function isAbortError(cause: unknown) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "AbortError"
  );
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new TavilyError(`Invalid Tavily ${label}`, {
      recoverable: false,
      cause: result.error,
    });
  }
  return result.data;
}

function getConfiguration() {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new TavilyError("TAVILY_API_KEY is required", {
      recoverable: false,
    });
  }

  const baseUrl = parseInput(
    httpUrlSchema,
    process.env.TAVILY_BASE_URL?.trim() || DEFAULT_BASE_URL,
    "base URL",
  );

  return { apiKey, baseUrl: `${baseUrl.replace(/\/+$/, "")}/` };
}

// Models never perform HTTP requests themselves: they propose research actions,
// while this adapter owns credentials, network failures, and external response shapes.
async function request(path: string, body: unknown, signal?: AbortSignal) {
  const { apiKey, baseUrl } = getConfiguration();
  let response: Response;

  try {
    response = await fetch(
      new URL(path.replace(/^\//, ""), baseUrl).toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
  } catch (cause) {
    if (isAbortError(cause)) {
      throw cause;
    }
    throw new TavilyError(`Tavily request to ${path} failed`, {
      recoverable: true,
      cause,
    });
  }

  if (!response.ok) {
    throw new TavilyError(
      `Tavily request to ${path} failed with status ${response.status}`,
      {
        recoverable: response.status === 429 || response.status >= 500,
        status: response.status,
      },
    );
  }

  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new TavilyError(`Tavily ${path} returned invalid JSON`, {
      recoverable: false,
      cause,
    });
  }
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  path: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TavilyError(`Tavily ${path} returned an invalid response`, {
      recoverable: false,
      cause: result.error,
    });
  }
  return result.data;
}

export async function searchWeb(
  query: string,
  options: { timeRange: "all" | "year" | "month" | "week" },
  signal?: AbortSignal,
): Promise<Source[]> {
  const validQuery = parseInput(querySchema, query, "search query");
  const body = {
    query: validQuery,
    search_depth: "basic",
    ...(options.timeRange === "all" ? {} : { time_range: options.timeRange }),
    max_results: 6,
    include_answer: false,
    include_raw_content: false,
  };
  const external = parseResponse(
    tavilySearchResponseSchema,
    await request("/search", body, signal),
    "/search",
  );

  return external.results.map((result) =>
    sourceSchema.parse({
      id: `source-${createHash("sha1").update(result.url).digest("hex").slice(0, 10)}`,
      title: result.title,
      url: result.url,
      domain: new URL(result.url).hostname,
      snippet: result.content,
      publishedAt: result.published_date ?? undefined,
      score: result.score,
    }),
  );
}

export async function extractSources(
  urls: string[],
  question: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const validUrls = parseInput(inputUrlsSchema, urls, "extraction URLs");
  const validQuestion = parseInput(questionSchema, question, "extraction query");
  const external = parseResponse(
    tavilyExtractResponseSchema,
    await request(
      "/extract",
      {
        urls: validUrls,
        query: validQuestion,
        chunks_per_source: 3,
        extract_depth: "basic",
        format: "markdown",
        include_images: false,
      },
      signal,
    ),
    "/extract",
  );

  return new Map(
    external.results.map((result) => [result.url, result.raw_content]),
  );
}
