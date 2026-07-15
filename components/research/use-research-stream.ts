"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  decodeEventLine,
  researchEventSchema,
  type ResearchEvent,
} from "@/lib/agent/research-events";
import {
  researchInputSchema,
  type ResearchRequest,
} from "@/lib/agent/research-types";

export type ResearchRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export interface ResearchRun {
  status: ResearchRunStatus;
  events: ResearchEvent[];
  error?: string;
}

type State = ResearchRun & { generation: number };
type Action =
  | { type: "start"; generation: number }
  | { type: "event"; generation: number; event: ResearchEvent }
  | { type: "fail"; generation: number; error: string; recoverable: boolean }
  | { type: "cancel"; generation: number }
  | { type: "reset"; generation: number };

const initialState: State = { status: "idle", events: [], generation: 0 };
const terminalStatuses: Partial<
  Record<ResearchEvent["type"], ResearchRunStatus>
> = {
  "report.completed": "completed",
  "research.partial": "partial",
  "research.cancelled": "cancelled",
  "research.failed": "failed",
};

function localFailureEvent(
  message: string,
  recoverable: boolean,
): Extract<ResearchEvent, { type: "research.failed" }> {
  const event = researchEventSchema.parse({
    type: "research.failed",
    message,
    recoverable,
  });
  if (event.type !== "research.failed") throw new Error("Invalid local failure event");
  return event;
}

function reducer(state: State, action: Action): State {
  if (action.type === "start") {
    return { status: "running", events: [], generation: action.generation };
  }
  if (action.type === "reset") {
    return { status: "idle", events: [], generation: action.generation };
  }
  if (action.generation !== state.generation) return state;

  if (action.type === "cancel") {
    if (state.status !== "running") return state;
    const event = researchEventSchema.parse({ type: "research.cancelled" });
    return {
      ...state,
      status: "cancelled",
      // 本地取消没有服务端 NDJSON 记录；只在尚无终止事件时补一条，避免双重终止卡片。
      events: state.events.some(isTerminal)
        ? state.events
        : [...state.events, event],
      error: undefined,
    };
  }
  if (action.type === "fail") {
    const event = localFailureEvent(action.error, action.recoverable);
    return {
      ...state,
      status: "failed",
      // 客户端只能合成固定、已清洗的公开消息；若服务端已发终止事件，仅更新状态而不追加。
      events: state.events.some(isTerminal)
        ? state.events
        : [...state.events, event],
      error: event.message,
    };
  }

  const status = terminalStatuses[action.event.type] ?? state.status;
  return {
    ...state,
    status,
    events: [...state.events, action.event],
    error:
      action.event.type === "research.failed"
        ? action.event.message
        : undefined,
  };
}

class ProtocolError extends Error {}

function isTerminal(event: ResearchEvent): boolean {
  return terminalStatuses[event.type] !== undefined;
}

export function useResearchStream(): {
  run: ResearchRun;
  start(input: ResearchRequest): Promise<void>;
  retry(): Promise<void>;
  canRetry: boolean;
  cancel(): void;
  reset(): void;
} {
  const [state, dispatch] = useReducer(reducer, initialState);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const lastInputRef = useRef<ResearchRequest | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const isCurrent = useCallback(
    (generation: number) =>
      mountedRef.current && generationRef.current === generation,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const start = useCallback(
    async (rawInput: ResearchRequest) => {
      controllerRef.current?.abort();
      const generation = ++generationRef.current;
      const parsed = researchInputSchema.safeParse(rawInput);

      if (!parsed.success) {
        dispatch({
          type: "start",
          generation,
        });
        dispatch({
          type: "fail",
          generation,
          error: "Invalid research request.",
          recoverable: false,
        });
        controllerRef.current = null;
        return;
      }

      lastInputRef.current = parsed.data;
      setCanRetry(true);

      const controller = new AbortController();
      controllerRef.current = controller;
      dispatch({ type: "start", generation });

      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let protocolFailure = false;

      try {
        const response = await fetch("/api/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
          signal: controller.signal,
        });

        if (!response.ok) {
          if (isCurrent(generation)) {
            dispatch({
              type: "fail",
              generation,
              error: "Research request failed.",
              recoverable: true,
            });
          }
          return;
        }
        if (!response.body) {
          if (isCurrent(generation)) {
            dispatch({
              type: "fail",
              generation,
              error: "Research stream failed.",
              recoverable: true,
            });
          }
          return;
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffer = "";
        let terminalSeen = false;

        const processRecord = (record: string) => {
          if (terminalSeen) throw new ProtocolError();
          let event: ResearchEvent;
          try {
            event = decodeEventLine(
              record.endsWith("\r") ? record.slice(0, -1) : record,
            );
          } catch {
            throw new ProtocolError();
          }
          if (!isCurrent(generation)) return;
          dispatch({ type: "event", generation, event });
          terminalSeen = isTerminal(event);
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            try {
              buffer += decoder.decode();
            } catch {
              throw new ProtocolError();
            }
            break;
          }

          // Network chunks are arbitrary byte groups, never message boundaries.
          try {
            buffer += decoder.decode(value, { stream: true });
          } catch {
            throw new ProtocolError();
          }
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const record = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            processRecord(record);
            newline = buffer.indexOf("\n");
          }
        }

        if (buffer.length > 0) throw new ProtocolError();
        if (!terminalSeen && isCurrent(generation)) {
          dispatch({
            type: "fail",
            generation,
            error: "Research stream failed.",
            recoverable: true,
          });
        }
      } catch (error) {
        if (!isCurrent(generation)) return;
        if (error instanceof ProtocolError || error instanceof SyntaxError) {
          protocolFailure = true;
          dispatch({
            type: "fail",
            generation,
            error: "Research stream protocol error.",
            recoverable: true,
          });
        } else if (controller.signal.aborted) {
          dispatch({ type: "cancel", generation });
        } else {
          dispatch({
            type: "fail",
            generation,
            error: reader
              ? "Research stream failed."
              : "Unable to complete research.",
            recoverable: true,
          });
        }
      } finally {
        if (protocolFailure && reader) {
          try {
            await reader.cancel();
          } catch {
            // The public protocol error is already recorded.
          }
        }
        if (reader) {
          try {
            reader.releaseLock();
          } catch {
            // Lock cleanup must never replace the run's terminal outcome.
          }
        }
        if (isCurrent(generation)) controllerRef.current = null;
      }
    },
    [isCurrent],
  );

  const cancel = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    dispatch({ type: "cancel", generation: generationRef.current });
    generationRef.current += 1;
    controller.abort();
    controllerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    const generation = ++generationRef.current;
    dispatch({ type: "reset", generation });
  }, []);

  const retry = useCallback(async () => {
    const input = lastInputRef.current;
    if (!input) return;
    // 重试只复用已校验输入；start 会创建新 generation 并清空旧事件与运行状态。
    await start(input);
  }, [start]);

  const run: ResearchRun =
    state.error === undefined
      ? { status: state.status, events: state.events }
      : { status: state.status, events: state.events, error: state.error };
  return { run, start, retry, canRetry, cancel, reset };
}
