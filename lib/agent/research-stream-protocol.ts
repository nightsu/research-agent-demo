import {
  decodeEventLine,
  encodeEvent,
  MAX_ENCODED_EVENT_BYTES,
  type ResearchEvent,
} from "./research-events";

export type ResearchRequestKind = "plan" | "execute";

export type RequestTerminalEvent = Extract<
  ResearchEvent,
  {
    type:
      | "plan.awaiting_approval"
      | "report.completed"
      | "research.partial"
      | "research.cancelled"
      | "research.failed";
  }
>;

export type ResearchTerminalEvent = Exclude<
  RequestTerminalEvent,
  { type: "plan.awaiting_approval" }
>;

export type DurableResearchEvent = Exclude<
  ResearchEvent,
  { type: "report.delta" }
>;

export interface TransientDraft {
  markdown: string;
  sequence: number;
}

export type ResearchStreamProtocolErrorCode =
  | "INVALID_UTF8"
  | "INVALID_RECORD"
  | "EVENT_TOO_LARGE"
  | "UNEXPECTED_EVENT"
  | "UNEXPECTED_TERMINAL"
  | "EVENT_AFTER_TERMINAL"
  | "MISSING_REQUEST_TERMINAL"
  | "TRAILING_BYTES"
  | "INVALID_DELTA_SEQUENCE"
  | "DELTA_WITHOUT_REPORT"
  | "DUPLICATE_REPORT_START"
  | "TRANSPORT_AFTER_TERMINAL"
  | "WRITER_CLOSED";

export class ResearchStreamProtocolError extends Error {
  constructor(
    readonly code: ResearchStreamProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchStreamProtocolError";
  }
}

export interface ConsumeResearchStreamOptions {
  request: ResearchRequestKind;
  cancellationSignal?: AbortSignal;
  onDurableEvent?(
    event: DurableResearchEvent,
  ): void | Promise<void>;
  onTransientDraft?(draft: TransientDraft): void | Promise<void>;
}

export interface ResearchStreamResult {
  requestTerminal: RequestTerminalEvent;
  researchTerminal?: ResearchTerminalEvent;
  transientDraft?: TransientDraft;
  retainedViolations: readonly ResearchStreamProtocolError[];
}

export type ResearchStreamDelivery = (
  encoded: Uint8Array,
) => void | Promise<void>;

export interface ResearchStreamWriterGate {
  deliver(
    event: ResearchEvent,
    delivery: ResearchStreamDelivery,
  ): Promise<void>;
  finish(options: {
    fallbackEvent: ResearchTerminalEvent;
    deliver: ResearchStreamDelivery;
  }): Promise<RequestTerminalEvent>;
}

export function isRequestTerminal(
  event: ResearchEvent,
): event is RequestTerminalEvent {
  return (
    event.type === "plan.awaiting_approval" ||
    event.type === "report.completed" ||
    event.type === "research.partial" ||
    event.type === "research.cancelled" ||
    event.type === "research.failed"
  );
}

export function isResearchTerminal(
  event: ResearchEvent,
): event is ResearchTerminalEvent {
  return isRequestTerminal(event) && event.type !== "plan.awaiting_approval";
}

function assertExpectedTerminal(
  request: ResearchRequestKind,
  event: RequestTerminalEvent,
): void {
  if (request === "execute" && event.type === "plan.awaiting_approval") {
    throw new ResearchStreamProtocolError(
      "UNEXPECTED_TERMINAL",
      "The execution stream ended at Plan Review.",
    );
  }
  if (
    request === "plan" &&
    (event.type === "report.completed" || event.type === "research.partial")
  ) {
    throw new ResearchStreamProtocolError(
      "UNEXPECTED_TERMINAL",
      "The plan stream ended with an execution outcome.",
    );
  }
}

function assertEventAllowed(
  request: ResearchRequestKind,
  event: ResearchEvent,
): void {
  const isSharedTerminal =
    event.type === "research.cancelled" || event.type === "research.failed";
  const isPlanEvent = event.type.startsWith("plan.");
  const allowed = request === "plan"
    ? isPlanEvent || isSharedTerminal
    : !isPlanEvent;

  if (!allowed) {
    throw new ResearchStreamProtocolError(
      "UNEXPECTED_EVENT",
      `The ${request} stream produced an event from the wrong request phase.`,
    );
  }
}

export async function consumeResearchStream(
  source: ReadableStream<Uint8Array>,
  options: ConsumeResearchStreamOptions,
): Promise<ResearchStreamResult> {
  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const byteCounter = new TextEncoder();
  let buffer = "";
  let requestTerminal: RequestTerminalEvent | undefined;
  let transientDraft: TransientDraft | undefined;
  let nextDeltaSequence = 0;
  let reportStarted = false;
  const retainedViolations: ResearchStreamProtocolError[] = [];
  let resolveCancellation: (() => void) | undefined;
  const cancellation = options.cancellationSignal
    ? new Promise<"cancelled">((resolve) => {
        resolveCancellation = () => resolve("cancelled");
      })
    : undefined;
  const onCancellation = () => resolveCancellation?.();
  options.cancellationSignal?.addEventListener("abort", onCancellation, {
    once: true,
  });
  if (options.cancellationSignal?.aborted) onCancellation();

  const result = (): ResearchStreamResult => {
    if (!requestTerminal) {
      throw new ResearchStreamProtocolError(
        "MISSING_REQUEST_TERMINAL",
        "The stream ended without a Request Terminal.",
      );
    }
    return {
      requestTerminal,
      ...(isResearchTerminal(requestTerminal)
        ? { researchTerminal: requestTerminal }
        : {}),
      ...(transientDraft ? { transientDraft } : {}),
      retainedViolations,
    };
  };

  const cancelReaderSafely = async (reason?: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } catch {
      // Cleanup must not replace the protocol or adapter outcome.
    }
  };

  const consumeRecord = async (record: string): Promise<boolean> => {
    if (requestTerminal) {
      const violation = new ResearchStreamProtocolError(
        "EVENT_AFTER_TERMINAL",
        "The stream produced an event after its Request Terminal.",
      );
      // Plan Review 会授权后续外部研究，因此尾部异常必须 fail closed；
      // Research Terminal 已是公开结果，后续传输违规不能改写首个权威终态。
      if (isResearchTerminal(requestTerminal)) {
        retainedViolations.push(violation);
        return true;
      }
      throw violation;
    }

    if (byteCounter.encode(`${record}\n`).byteLength > MAX_ENCODED_EVENT_BYTES) {
      throw new ResearchStreamProtocolError(
        "EVENT_TOO_LARGE",
        "The stream contained an oversized research event.",
      );
    }

    let event: ResearchEvent;
    try {
      event = decodeEventLine(record.endsWith("\r") ? record.slice(0, -1) : record);
    } catch {
      throw new ResearchStreamProtocolError(
        "INVALID_RECORD",
        "The stream contained an invalid research event.",
      );
    }
    if (isRequestTerminal(event)) assertExpectedTerminal(options.request, event);
    assertEventAllowed(options.request, event);

    if (event.type === "report.started") {
      if (reportStarted) {
        throw new ResearchStreamProtocolError(
          "DUPLICATE_REPORT_START",
          "The stream started a second report draft.",
        );
      }
      reportStarted = true;
    } else if (event.type === "report.delta") {
      if (!reportStarted) {
        throw new ResearchStreamProtocolError(
          "DELTA_WITHOUT_REPORT",
          "The stream produced a report delta before report.started.",
        );
      }
      if (event.sequence !== nextDeltaSequence) {
        throw new ResearchStreamProtocolError(
          "INVALID_DELTA_SEQUENCE",
          "The report draft sequence is not contiguous.",
        );
      }
      transientDraft = {
        markdown:
          event.mode === "append"
            ? `${transientDraft?.markdown ?? ""}${event.text}`
            : event.text,
        sequence: event.sequence,
      };
      nextDeltaSequence += 1;
      await options.onTransientDraft?.(transientDraft);
      return false;
    }
    if (isRequestTerminal(event)) {
      if (event.type === "plan.awaiting_approval") {
        // 审批本身会授权外部研究；只有 clean EOF 才能把这个 provisional
        // Request Terminal 公开给 Hook，避免合法终态后的恶意尾部抢先获批。
        requestTerminal = event;
        return false;
      }
    }
    await options.onDurableEvent?.(event);
    if (isRequestTerminal(event)) requestTerminal = event;
    return false;
  };

  try {
    while (true) {
      const read = reader.read();
      const next = cancellation
        ? await Promise.race([read, cancellation])
        : await read;
      if (next === "cancelled") {
        if (requestTerminal && isResearchTerminal(requestTerminal)) {
          await cancelReaderSafely(options.cancellationSignal?.reason);
          return result();
        }
        const event: ResearchTerminalEvent = { type: "research.cancelled" };
        await options.onDurableEvent?.(event);
        requestTerminal = event;
        await reader.cancel(options.cancellationSignal?.reason);
        return result();
      }
      const { done, value } = next;
      if (done) {
        try {
          buffer += decoder.decode();
        } catch {
          throw new ResearchStreamProtocolError(
            "INVALID_UTF8",
            "The stream ended with invalid UTF-8.",
          );
        }
        break;
      }

      try {
        buffer += decoder.decode(value, { stream: true });
      } catch {
        throw new ResearchStreamProtocolError(
          "INVALID_UTF8",
          "The stream contained invalid UTF-8.",
        );
      }

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const record = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (await consumeRecord(record)) {
          await cancelReaderSafely();
          return result();
        }
        newline = buffer.indexOf("\n");
      }
      if (
        byteCounter.encode(buffer).byteLength + 1 >
        MAX_ENCODED_EVENT_BYTES
      ) {
        throw new ResearchStreamProtocolError(
          "EVENT_TOO_LARGE",
          "The stream contained an oversized research event.",
        );
      }
    }
    if (buffer.length > 0) {
      throw new ResearchStreamProtocolError(
        "TRAILING_BYTES",
        "The stream ended with an incomplete research event.",
      );
    }
    if (requestTerminal?.type === "plan.awaiting_approval") {
      await options.onDurableEvent?.(requestTerminal);
    }
    return result();
  } catch (error) {
    if (requestTerminal && isResearchTerminal(requestTerminal)) {
      if (error instanceof ResearchStreamProtocolError) {
        retainedViolations.push(error);
      } else {
        retainedViolations.push(
          new ResearchStreamProtocolError(
            "TRANSPORT_AFTER_TERMINAL",
            "The transport failed after the Research Terminal.",
          ),
        );
      }
      await cancelReaderSafely(error);
      return result();
    }
    await cancelReaderSafely(error);
    throw error;
  } finally {
    options.cancellationSignal?.removeEventListener("abort", onCancellation);
    try {
      reader.releaseLock();
    } catch {
      // Lock cleanup must never replace the stream outcome.
    }
  }
}

export function createResearchStreamWriterGate(
  request: ResearchRequestKind,
): ResearchStreamWriterGate {
  const encoder = new TextEncoder();
  let requestTerminal: RequestTerminalEvent | undefined;
  let closed = false;
  let finishing = false;
  let finishPromise: Promise<RequestTerminalEvent> | undefined;
  let deliveryQueue = Promise.resolve();

  const performDelivery = async (
    event: ResearchEvent,
    delivery: ResearchStreamDelivery,
  ): Promise<void> => {
    if (requestTerminal) {
      throw new ResearchStreamProtocolError(
        "WRITER_CLOSED",
        "The writer cannot deliver another event after its Request Terminal.",
      );
    }
    if (isRequestTerminal(event)) assertExpectedTerminal(request, event);
    assertEventAllowed(request, event);

    const encoded = encoder.encode(encodeEvent(event));
    await delivery(encoded);
    if (isRequestTerminal(event)) requestTerminal = event;
  };

  const deliver = (
    event: ResearchEvent,
    delivery: ResearchStreamDelivery,
  ): Promise<void> => {
    if (closed || finishing) {
      return Promise.reject(
        new ResearchStreamProtocolError(
          "WRITER_CLOSED",
          "The writer has already started finishing.",
        ),
      );
    }
    const scheduled = deliveryQueue.then(() =>
      performDelivery(event, delivery),
    );
    // Provider telemetry 与报告 callback 可能在同一微任务窗口 emit；这里统一串行，
    // 让所有 adapter 看到相同 wire order，并只在 delivery 成功后提交协议状态。
    deliveryQueue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };

  return {
    deliver,
    finish({ fallbackEvent, deliver: delivery }) {
      if (closed) {
        return Promise.reject(
          new ResearchStreamProtocolError(
            "WRITER_CLOSED",
            "The writer has already finished.",
          ),
        );
      }
      if (finishPromise) return finishPromise;
      finishing = true;
      finishPromise = (async () => {
        await deliveryQueue;
        if (!requestTerminal) {
          await performDelivery(fallbackEvent, delivery);
        }
        closed = true;
        return requestTerminal!;
      })();
      return finishPromise;
    },
  };
}
