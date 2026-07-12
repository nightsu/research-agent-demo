import { runResearch } from "../../../lib/agent/research-agent";
import {
  encodeEvent,
  type ResearchEvent,
} from "../../../lib/agent/research-events";
import {
  researchInputSchema,
  type ResearchInput,
} from "../../../lib/agent/research-types";
import {
  createResearchModel,
  type ResearchModel,
} from "../../../lib/providers/research-model";
import {
  extractSources,
  searchWeb,
} from "../../../lib/tools/tavily";

export const maxDuration = 300;

const STREAM_HEADERS = {
  "cache-control": "no-cache, no-transform",
  "content-type": "application/x-ndjson; charset=utf-8",
  "x-accel-buffering": "no",
};

const FALLBACK_FAILURE: ResearchEvent = {
  type: "research.failed",
  message: "The research request failed.",
  recoverable: false,
};

const terminalEventTypes = new Set<ResearchEvent["type"]>([
  "report.completed",
  "research.partial",
  "research.cancelled",
  "research.failed",
]);

export interface ResearchRouteDependencies {
  createModel: () => ResearchModel;
  runResearch: typeof runResearch;
  searchWeb: typeof searchWeb;
  extractSources: typeof extractSources;
}

function safeJsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

export function createResearchRoute(dependencies: ResearchRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    let input: ResearchInput;

    try {
      const body: unknown = await request.json();
      const parsed = researchInputSchema.safeParse(body);
      if (!parsed.success) {
        return safeJsonError("研究问题格式无效，请检查后重试。", 400);
      }
      input = parsed.data;
    } catch {
      return safeJsonError("请求内容不是有效的 JSON。", 400);
    }

    let model: ResearchModel;
    try {
      model = dependencies.createModel();
    } catch {
      return safeJsonError("研究服务暂时不可用，请稍后重试。", 500);
    }

    const workflowController = new AbortController();
    const onRequestAbort = () =>
      workflowController.abort(request.signal.reason);

    if (request.signal.aborted) onRequestAbort();
    else request.signal.addEventListener("abort", onRequestAbort, { once: true });

    const encoder = new TextEncoder();
    let writable = true;
    let closed = false;
    let cleanedUp = false;
    let eventCount = 0;
    let terminalEvent: ResearchEvent["type"] | null = null;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      request.signal.removeEventListener("abort", onRequestAbort);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = async (event: ResearchEvent): Promise<void> => {
          if (!writable || workflowController.signal.aborted && !request.signal.aborted) {
            throw workflowController.signal.reason ?? new Error("Stream is closed");
          }

          const encoded = encoder.encode(encodeEvent(event));
          controller.enqueue(encoded);
          eventCount += 1;
          if (terminalEventTypes.has(event.type)) terminalEvent = event.type;
        };

        void dependencies
          .runResearch(
            input,
            {
              model,
              searchWeb: dependencies.searchWeb,
              extractSources: dependencies.extractSources,
              emit,
            },
            workflowController.signal,
          )
          .catch(() => {
            if (
              writable &&
              !workflowController.signal.aborted &&
              eventCount === 0 &&
              terminalEvent === null
            ) {
              controller.enqueue(encoder.encode(encodeEvent(FALLBACK_FAILURE)));
              eventCount += 1;
              terminalEvent = FALLBACK_FAILURE.type;
            }
          })
          .finally(() => {
            cleanup();
            if (writable && !closed) {
              closed = true;
              writable = false;
              controller.close();
            }
          });
      },
      cancel(reason) {
        writable = false;
        closed = true;
        cleanup();
        if (!workflowController.signal.aborted) {
          workflowController.abort(reason);
        }
      },
    });

    return new Response(stream, { status: 200, headers: STREAM_HEADERS });
  };
}

export const POST = createResearchRoute({
  createModel: createResearchModel,
  runResearch,
  searchWeb,
  extractSources,
});
