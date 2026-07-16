import { runResearch } from "../agent/research-agent";
import { encodeEvent, type ResearchEvent } from "../agent/research-events";
import {
  researchInputSchema,
  type ResearchInput,
} from "../agent/research-types";
import type { ResearchModel } from "../providers/research-model";
import { extractSources, searchWeb } from "../tools/tavily";

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

    const encoder = new TextEncoder();
    const workflowController = new AbortController();
    let writable = true;
    let closed = false;
    let cleanedUp = false;
    let terminalEvent: ResearchEvent["type"] | null = null;
    let capacityWaiter: {
      resolve: () => void;
      reject: (reason: unknown) => void;
    } | null = null;

    const closedReason = () =>
      workflowController.signal.reason ?? new Error("Research stream is closed");

    const rejectCapacityWaiter = (reason: unknown) => {
      const waiter = capacityWaiter;
      capacityWaiter = null;
      waiter?.reject(reason);
    };

    const onRequestAbort = () => {
      if (!workflowController.signal.aborted) {
        workflowController.abort(request.signal.reason);
      }
      rejectCapacityWaiter(closedReason());
    };

    if (request.signal.aborted) onRequestAbort();
    else request.signal.addEventListener("abort", onRequestAbort, { once: true });

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      request.signal.removeEventListener("abort", onRequestAbort);
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const assertCanEmit = (event: ResearchEvent) => {
          if (!writable) throw closedReason();
          if (terminalEvent !== null) {
            throw new Error(`Research terminal event already emitted: ${terminalEvent}`);
          }
          if (
            workflowController.signal.aborted &&
            event.type !== "research.cancelled"
          ) {
            throw closedReason();
          }
        };

        const waitForCapacity = async (): Promise<void> => {
          if (!writable || closed || workflowController.signal.aborted) {
            throw closedReason();
          }
          if ((controller.desiredSize ?? 0) > 0) return;
          if (capacityWaiter !== null) {
            throw new Error("Concurrent research event delivery is not supported");
          }

          await new Promise<void>((resolve, reject) => {
            capacityWaiter = { resolve, reject };
          });
        };

        const emit = async (event: ResearchEvent): Promise<void> => {
          assertCanEmit(event);
          const encoded = encoder.encode(encodeEvent(event));
          const abortedCancellation =
            event.type === "research.cancelled" &&
            workflowController.signal.aborted;
          // Cancellation is the sole post-abort record. It must not deadlock
          // behind capacity that a disconnected requester may never pull.
          if (!abortedCancellation) await waitForCapacity();
          assertCanEmit(event);
          controller.enqueue(encoded);
          if (terminalEventTypes.has(event.type)) terminalEvent = event.type;
        };

        const ensureTerminal = async (): Promise<void> => {
          if (
            !writable ||
            workflowController.signal.aborted ||
            terminalEvent !== null
          ) {
            return;
          }
          try {
            await emit(FALLBACK_FAILURE);
          } catch {
            // Cancellation or a concurrent close can make the stream unwritable.
          }
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
          .then(ensureTerminal, ensureTerminal)
          .finally(() => {
            cleanup();
            if (writable && !closed) {
              closed = true;
              writable = false;
              rejectCapacityWaiter(new Error("Research workflow completed"));
              controller.close();
            }
          });
      },
      pull() {
        const waiter = capacityWaiter;
        capacityWaiter = null;
        waiter?.resolve();
      },
      cancel(reason) {
        writable = false;
        closed = true;
        rejectCapacityWaiter(reason ?? new Error("Research stream cancelled"));
        cleanup();
        if (!workflowController.signal.aborted) {
          workflowController.abort(reason);
        }
      },
    });

    return new Response(stream, { status: 200, headers: STREAM_HEADERS });
  };
}
