# Structured Research Printer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat event timeline with an accessible structured printer stream that groups search batches, pauses auto-follow while the reader scrolls, promotes the report on completion, and opens source evidence in a side drawer.

**Architecture:** Keep `ResearchEvent[]` as the single client-side source of truth. A pure `derivePrinterRecords()` projection groups protocol events into display records, while small client components own scrolling and drawer focus behavior; `ResearchWorkbench` only composes run-state layouts. The server Agent, NDJSON protocol, provider, and Tavily layers remain unchanged.

**Tech Stack:** Next.js 16.2 App Router, React 19.2, TypeScript 5, Vitest 4, Testing Library, existing CSS/Tailwind v4 import, native HTML dialog/details semantics where practical.

---

## File map

| Path | Responsibility |
| --- | --- |
| `components/research/research-printer-model.ts` | Pure `ResearchEvent[] -> PrinterRecord[]` projection and safe search-batch association |
| `components/research/research-printer-model.test.ts` | Projection order, grouping, repeated-query, unknown-source, and privacy tests |
| `components/research/research-printer.tsx` | Printer record rendering, details, source actions, auto-follow pause/resume |
| `components/research/research-printer.test.tsx` | Accessible rendering and scroll-follow behavior tests |
| `components/research/source-drawer.tsx` | Modal source evidence drawer, Escape/overlay close, focus restoration, scroll lock |
| `components/research/source-drawer.test.tsx` | Drawer content, close paths, and focus behavior tests |
| `components/research/use-research-stream.ts` | Retain the last validated request and expose a from-scratch retry action |
| `components/research/use-research-stream.test.tsx` | Retry request and fresh-generation tests |
| `components/research/research-workbench.tsx` | Compose running, completed/partial, and interrupted layouts |
| `components/research/research-workbench.test.tsx` | End-to-end UI state and shared source-drawer entry tests |
| `components/research/event-timeline.tsx` | Remove after its behavior has moved to the printer |
| `components/research/source-card.tsx` | Remove after source evidence has moved to the drawer |
| `app/globals.css` | Fixed workspace, independent scroll, printer, collapse, drawer, animation, responsive rules |
| `docs/architecture.md` | Explain the printer projection and recommended learning path |

## Task 1: Lock the client boundary and printer record model

**Files:**
- Read: `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
- Read: `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`
- Create: `components/research/research-printer-model.test.ts`
- Create: `components/research/research-printer-model.ts`

- [x] **Step 1: Confirm the Next.js 16 boundary before code changes**

Read the two local documents above and record the implementation decision in the code review notes: `ResearchWorkbench` remains the single explicit `"use client"` entry point; printer-model stays pure, and interactive descendants inherit the client module graph.

- [x] **Step 2: Write failing projection tests**

Create `components/research/research-printer-model.test.ts` with real protocol events and these assertions:

```ts
import { describe, expect, it } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { Source } from "@/lib/agent/research-types";

import { derivePrinterRecords } from "./research-printer-model";

const source: Source = {
  id: "source-1",
  title: "Primary evidence",
  url: "https://example.com/evidence",
  domain: "example.com",
  snippet: "Evidence summary",
};

const searchEvents: ResearchEvent[] = [
  { type: "search.started", query: "browser changes", reason: "Find primary evidence" },
  { type: "search.completed", query: "browser changes", sources: [source], resultCount: 4 },
  { type: "source.read", sourceId: source.id, url: source.url },
  {
    type: "source.evaluated",
    evaluation: {
      sourceId: source.id,
      decision: "accepted",
      relevance: 5,
      authority: 4,
      freshness: 5,
      reason: "Direct evidence",
    },
  },
];

describe("derivePrinterRecords", () => {
  it("groups one search round and its source lifecycle into one record", () => {
    const records = derivePrinterRecords(searchEvents);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "search",
      query: "browser changes",
      status: "complete",
      resultCount: 4,
      sources: [{ source, read: true, evaluation: { decision: "accepted" } }],
    });
  });

  it("keeps repeated queries as distinct batches and ignores progress noise", () => {
    const records = derivePrinterRecords([
      ...searchEvents.slice(0, 2),
      { type: "progress.updated", operationCount: 2, operationLimit: 10, searchRounds: 1, searchRoundLimit: 3 },
      ...searchEvents.slice(0, 2),
    ]);
    expect(records.filter((record) => record.kind === "search")).toHaveLength(2);
  });

  it("does not invent display sources for unknown source ids", () => {
    const records = derivePrinterRecords([
      ...searchEvents.slice(0, 2),
      { type: "source.read", sourceId: "unknown", url: "https://unknown.example" },
    ]);
    expect(records[0]).toMatchObject({ sources: [{ source, read: false }] });
  });
});
```

- [x] **Step 3: Run the focused test and verify RED**

Run: `npm test -- components/research/research-printer-model.test.ts`

Expected: FAIL because `./research-printer-model` does not exist.

- [x] **Step 4: Implement the discriminated union and pure projection**

Create `components/research/research-printer-model.ts` with exported record types and `derivePrinterRecords(events)`. Use a single ordered pass, stable IDs such as `search-${eventIndex}`, and reverse matching for the most recent incomplete search with the same query. Include Chinese comments at the two non-obvious invariants:

```ts
import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchPlan, Source, SourceEvaluation } from "@/lib/agent/research-types";

export interface PrinterSource {
  source: Source;
  read: boolean;
  evaluation?: SourceEvaluation;
}

export type PrinterRecord =
  | { id: string; kind: "plan"; question: string; plan?: ResearchPlan; status: "running" | "complete" }
  | { id: string; kind: "search"; query: string; reason: string; status: "running" | "complete"; resultCount?: number; sources: PrinterSource[] }
  | { id: string; kind: "gap"; description: string; followUpQueries: string[] }
  | { id: string; kind: "conclusion"; summary: string }
  | { id: string; kind: "synthesis"; partial: boolean; status: "running" | "complete" }
  | { id: string; kind: "terminal"; outcome: "cancelled" | "failed"; message: string; recoverable: boolean };

export function derivePrinterRecords(events: ResearchEvent[]): PrinterRecord[] {
  const records: PrinterRecord[] = [];
  // 事件日志是唯一事实来源；这里仅做可重放的展示投影，不能产生新的研究结论。
  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case "plan.started":
        records.push({ id: `plan-${index}`, kind: "plan", question: event.question, status: "running" });
        break;
      case "plan.completed": {
        const record = records.toReversed().find((item) => item.kind === "plan" && item.status === "running");
        if (record?.kind === "plan") {
          record.plan = event.plan;
          record.status = "complete";
        } else {
          records.push({ id: `plan-${index}`, kind: "plan", question: event.plan.objective, plan: event.plan, status: "complete" });
        }
        break;
      }
      case "search.started":
        records.push({ id: `search-${index}`, kind: "search", query: event.query, reason: event.reason, status: "running", sources: [] });
        break;
      case "search.completed": {
        // 相同 query 可能重试；必须反向匹配最近一个未完成批次，不能覆盖更早的研究记录。
        const record = records.toReversed().find((item) => item.kind === "search" && item.query === event.query && item.status === "running");
        const sources = event.sources.map((source) => ({ source, read: false }));
        if (record?.kind === "search") {
          record.status = "complete";
          record.resultCount = event.resultCount;
          record.sources = sources;
        } else {
          records.push({ id: `search-${index}`, kind: "search", query: event.query, reason: "Search results received", status: "complete", resultCount: event.resultCount, sources });
        }
        break;
      }
      case "source.read": {
        const record = records.toReversed().find((item) => item.kind === "search" && item.sources.some((entry) => entry.source.id === event.sourceId));
        const entry = record?.kind === "search" ? record.sources.find((item) => item.source.id === event.sourceId) : undefined;
        if (entry) entry.read = true;
        break;
      }
      case "source.evaluated": {
        const record = records.toReversed().find((item) => item.kind === "search" && item.sources.some((entry) => entry.source.id === event.evaluation.sourceId));
        const entry = record?.kind === "search" ? record.sources.find((item) => item.source.id === event.evaluation.sourceId) : undefined;
        if (entry) entry.evaluation = event.evaluation;
        break;
      }
      case "gap.detected":
        records.push({ id: `gap-${index}`, kind: "gap", description: event.description, followUpQueries: event.followUpQueries });
        break;
      case "conclusion.updated":
        records.push({ id: `conclusion-${index}`, kind: "conclusion", summary: event.summary });
        break;
      case "report.started":
        records.push({ id: `synthesis-${index}`, kind: "synthesis", partial: event.partial, status: "running" });
        break;
      case "report.completed":
      case "research.partial": {
        const record = records.toReversed().find((item) => item.kind === "synthesis" && item.status === "running");
        if (record?.kind === "synthesis") record.status = "complete";
        else records.push({ id: `synthesis-${index}`, kind: "synthesis", partial: event.type === "research.partial", status: "complete" });
        break;
      }
      case "research.cancelled":
        records.push({ id: `terminal-${index}`, kind: "terminal", outcome: "cancelled", message: "Research stopped before completion.", recoverable: true });
        break;
      case "research.failed":
        records.push({ id: `terminal-${index}`, kind: "terminal", outcome: "failed", message: event.message, recoverable: event.recoverable });
        break;
      case "progress.updated":
        break;
    }
  }
  return records;
}
```

The function never serializes the original event or `rawContent` into a record. TypeScript's discriminated switch must remain exhaustive when the protocol gains a new event.

- [x] **Step 5: Run focused and existing projection tests**

Run: `npm test -- components/research/research-printer-model.test.ts components/research/research-view-model.test.ts`

Expected: both files PASS.

- [x] **Step 6: Commit the pure model slice**

```bash
git add components/research/research-printer-model.ts components/research/research-printer-model.test.ts
git commit -m "feat: project research events into printer records"
```

## Task 2: Render structured records and pause auto-follow

**Files:**
- Create: `components/research/research-printer.test.tsx`
- Create: `components/research/research-printer.tsx`
- Modify: `app/globals.css`

- [x] **Step 1: Write failing printer interaction tests**

Cover accessible labels, one search card with expandable sources, `onSourceSelect`, and scroll behavior. Define numeric scroll properties on the region so jsdom exercises the real distance calculation:

```tsx
it("pauses following when the reader leaves the bottom and resumes on request", () => {
  const { rerender } = render(<ResearchPrinter records={records} onSourceSelect={vi.fn()} />);
  const viewport = screen.getByRole("region", { name: /research process/i });
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 200 },
  });
  fireEvent.scroll(viewport);
  expect(screen.getByRole("button", { name: /back to latest progress/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /back to latest progress/i }));
  expect(screen.queryByRole("button", { name: /back to latest progress/i })).not.toBeInTheDocument();
  rerender(<ResearchPrinter records={[...records, conclusion]} onSourceSelect={vi.fn()} />);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- components/research/research-printer.test.tsx`

Expected: FAIL because `ResearchPrinter` does not exist.

- [x] **Step 3: Implement the printer component**

Create a client component that receives only serializable record data and an action callback:

```tsx
"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { PrinterRecord } from "./research-printer-model";

const BOTTOM_THRESHOLD_PX = 48;

export function ResearchPrinter({ records, onSourceSelect }: {
  records: PrinterRecord[];
  onSourceSelect(sourceId: string): void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [followingLatest, setFollowingLatest] = useState(true);

  const returnToLatest = useCallback(() => {
    setFollowingLatest(true);
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  useLayoutEffect(() => {
    if (!followingLatest) return;
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
  }, [followingLatest, records.length]);

  return (
    <section className="printer-shell" aria-labelledby="printer-title">
      <header className="section-heading"><div><p className="eyebrow">Live record</p><h2 id="printer-title">How the research unfolded</h2></div></header>
      <div
        ref={viewportRef}
        className="printer-viewport"
        role="region"
        aria-label="Research process"
        onScroll={(event) => {
          const node = event.currentTarget;
          setFollowingLatest(node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD_PX);
        }}
      >
        <ol className="printer-list">{records.map((record) => <PrinterRecordView key={record.id} record={record} onSourceSelect={onSourceSelect} />)}</ol>
      </div>
      {!followingLatest ? <button className="latest-button" type="button" onClick={returnToLatest}>Back to latest progress</button> : null}
    </section>
  );
}
```

Add `PrinterRecordView` in the same file with an exhaustive `switch (record.kind)`: `plan` renders objective/questions in `<details>`; `search` renders query/reason plus a `<details>` source list whose source titles are buttons; `gap` renders follow-up queries; `conclusion` renders the summary; `synthesis` renders running/complete text; `terminal` renders cancelled/failed text. Every card includes visible text for its status and no raw event JSON.

- [x] **Step 4: Add minimal printer CSS**

Add `.printer-shell`, `.printer-viewport`, `.printer-list`, `.printer-record`, `.printer-record-enter`, `.printer-source-list`, and `.latest-button`. Animate only opacity and transform; extend the existing reduced-motion block so smooth scroll and entry animation are disabled.

- [x] **Step 5: Run the printer tests and lint the component**

Run: `npm test -- components/research/research-printer.test.tsx && npm run lint -- components/research/research-printer.tsx`

Expected: PASS with no warnings.

- [x] **Step 6: Commit the printer slice**

```bash
git add components/research/research-printer.tsx components/research/research-printer.test.tsx app/globals.css
git commit -m "feat: render the structured research printer"
```

## Task 3: Add the accessible source drawer

**Files:**
- Create: `components/research/source-drawer.test.tsx`
- Create: `components/research/source-drawer.tsx`
- Modify: `app/globals.css`

- [x] **Step 1: Write failing drawer tests**

Test the actual dialog semantics, source/evaluation content, Escape and overlay close, and focus restoration:

```tsx
it("moves focus into the drawer and restores the source trigger on close", () => {
  const onClose = vi.fn();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const { rerender } = render(<SourceDrawer source={source} evaluation={evaluation} citationNumber={1} onClose={onClose} />);
  expect(screen.getByRole("dialog", { name: source.title })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /close source details/i })).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  rerender(<SourceDrawer onClose={onClose} />);
  expect(trigger).toHaveFocus();
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- components/research/source-drawer.test.tsx`

Expected: FAIL because `SourceDrawer` does not exist.

- [x] **Step 3: Implement modal semantics and evidence content**

Create `SourceDrawer` with optional `source`, `evaluation`, and `citationNumber` props. When open, save `document.activeElement`, set `document.body.style.overflow = "hidden"`, focus the close button, handle Escape, cycle Tab between focusable elements, and restore both overflow and focus during cleanup. Include this high-value comment:

```ts
// 抽屉关闭后恢复触发元素焦点，键盘用户才能从打开来源前的位置继续阅读。
```

Render title, domain/date, snippet, accepted/rejected status, three scores, reason, and a safe `_blank` link. Do not render `rawContent`.

- [x] **Step 4: Add drawer CSS and responsive rules**

Add fixed overlay/panel styles, a 220ms transform transition, high-contrast close button, and mobile width `min(92vw, 520px)`. Disable sliding under reduced motion.

- [x] **Step 5: Run drawer tests**

Run: `npm test -- components/research/source-drawer.test.tsx`

Expected: PASS including focus restoration.

- [x] **Step 6: Commit the drawer slice**

```bash
git add components/research/source-drawer.tsx components/research/source-drawer.test.tsx app/globals.css
git commit -m "feat: show research evidence in a source drawer"
```

## Task 4: Add from-scratch retry to the stream hook

**Files:**
- Modify: `components/research/use-research-stream.test.tsx`
- Modify: `components/research/use-research-stream.ts`

- [x] **Step 1: Write the failing retry test**

Add a test that makes the first fetch fail safely, calls `retry()`, returns a successful terminal event on the second fetch, and asserts the same normalized request body was sent twice while the final event array contains only the second run.

```tsx
expect(fetch).toHaveBeenNthCalledWith(2, "/api/research", expect.objectContaining({
  body: JSON.stringify(input),
}));
expect(result.current.run).toEqual({ status: "completed", events: [terminal] });
```

- [x] **Step 2: Run the focused retry test and verify RED**

Run: `npm test -- components/research/use-research-stream.test.tsx -t "retries the last valid request from scratch"`

Expected: FAIL because the hook does not expose `retry` or `canRetry`.

- [x] **Step 3: Retain only validated input and expose retry**

Add `lastInputRef`, assign `parsed.data` only after successful validation, and return:

```ts
const retry = useCallback(async () => {
  const input = lastInputRef.current;
  if (!input) return;
  await start(input);
}, [start]);

return { run, start, retry, canRetry: lastInputRef.current !== null, cancel, reset };
```

The existing `start` generation increment and `{ status: "running", events: [] }` reducer branch guarantee the retry does not mix old events. Add a Chinese comment explaining that retry reuses input, not workflow state.

- [x] **Step 4: Run all hook tests**

Run: `npm test -- components/research/use-research-stream.test.tsx`

Expected: PASS with existing cancellation and protocol tests unchanged.

- [x] **Step 5: Commit retry behavior**

```bash
git add components/research/use-research-stream.ts components/research/use-research-stream.test.tsx
git commit -m "feat: retry research runs from the original input"
```

## Task 5: Compose run states in ResearchWorkbench

**Files:**
- Modify: `components/research/research-workbench.test.tsx`
- Modify: `components/research/research-workbench.tsx`
- Delete: `components/research/event-timeline.tsx`
- Delete: `components/research/source-card.tsx`
- Modify: `app/globals.css`

- [x] **Step 1: Update mocks and write failing integration tests**

Extend the stream hook mock with `retry` and `canRetry`. Replace EventTimeline/SourceCard assertions with these behaviors:

```tsx
it("promotes a completed report and collapses the process by default", () => {
  mockedRun = { status: "completed", events: completedEvents };
  render(<ResearchWorkbench />);
  expect(screen.getByRole("heading", { name: report.title })).toBeInTheDocument();
  expect(screen.getByText(/view research process/i).closest("details")).not.toHaveAttribute("open");
});

it("keeps interrupted process visible and retries from scratch", () => {
  mockedRun = { status: "failed", events: completedEvents.slice(0, 5), error: "Research stream failed." };
  render(<ResearchWorkbench />);
  expect(screen.getByRole("region", { name: /research process/i })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /retry research/i }));
  expect(retry).toHaveBeenCalledOnce();
});

it("opens the same source drawer from a report citation", () => {
  mockedRun = { status: "completed", events: completedEvents };
  render(<ResearchWorkbench />);
  fireEvent.click(screen.getByRole("button", { name: /view source 1/i }));
  expect(screen.getByRole("dialog", { name: source.title })).toBeInTheDocument();
});
```

- [x] **Step 2: Run workbench tests and verify RED**

Run: `npm test -- components/research/research-workbench.test.tsx`

Expected: FAIL because the old timeline/source grid layout is still rendered.

- [x] **Step 3: Refactor the workbench composition**

In `ResearchWorkbench`:

1. derive `records` with `derivePrinterRecords(run.events)`;
2. resolve selected source aliases with `view.sourceIdentityById`;
3. render `ResearchPrinter` directly for running/failed/cancelled states;
4. for completed/partial, render `ResearchReportView` first and a closed `<details className="process-archive">` containing the printer;
5. render `SourceDrawer` once at the workbench root;
6. show both `Retry research` and `New research` for terminal states where `canRetry` is true;
7. retain the focused `role="status"` behavior after cancellation;
8. remove scroll-to-source-card logic because the drawer owns source navigation.

Use a Chinese comment at the state branch:

```tsx
// 完成态优先服务“阅读结论”，失败态优先服务“诊断过程”，所以只有前者自动折叠打印记录。
```

- [x] **Step 4: Remove replaced components and stale imports**

Delete `event-timeline.tsx` and `source-card.tsx` only after no test/import references remain. Keep `sourceDomId` only if another consumer still uses it; otherwise remove it and its tests.

- [x] **Step 5: Implement fixed workspace and independent scrolling**

Update desktop CSS so `.workspace-shell` uses `height: 100dvh`, `display: flex`, `flex-direction: column`, and `overflow: hidden`; `.workspace-grid` receives `min-height: 0; flex: 1`; `.workspace-content` receives `min-height: 0; overflow-y: auto`. Preserve readable document scrolling below 960px by reverting the shell to `height: auto; overflow: visible` and making the progress panel static.

- [x] **Step 6: Run integration and all component tests**

Run: `npm test -- components/research/research-workbench.test.tsx components/research/research-printer.test.tsx components/research/source-drawer.test.tsx`

Expected: PASS.

- [x] **Step 7: Commit workbench integration**

```bash
git add components/research/research-workbench.tsx components/research/research-workbench.test.tsx components/research/event-timeline.tsx components/research/source-card.tsx app/globals.css
git commit -m "feat: integrate the structured printer workspace"
```

## Task 6: Document the learning path and verify the whole application

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-07-15-structured-research-printer.md`

- [x] **Step 1: Update architecture documentation**

Add the printer projection and source drawer to the component table and browser Mermaid graph. Add a “结构化打印流” section explaining:

- protocol events remain the audit log;
- printer records are a replayable display projection, not a second workflow state machine;
- search lifecycle events are grouped by stable source IDs;
- public workflow decisions differ from private chain-of-thought;
- recommended reading order from event schema through stream, projection, printer, workbench, and drawer.

- [x] **Step 2: Run focused regression tests**

Run: `npm test -- components/research/research-printer-model.test.ts components/research/research-printer.test.tsx components/research/source-drawer.test.tsx components/research/use-research-stream.test.tsx components/research/research-workbench.test.tsx`

Expected: all focused tests PASS.

- [x] **Step 3: Run the full automated verification**

Run each command independently:

```bash
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0 with no unexpected warnings.

- [x] **Step 4: Run browser QA**

Start the app with `npm run dev`, then verify:

1. desktop left progress remains fixed while the right printer scrolls;
2. each new business record enters once and search-source updates do not replay the whole-card animation;
3. scrolling upward reveals “Back to latest progress” and new records do not steal position;
4. completed/partial report appears before a closed process archive;
5. failed/cancelled records remain open and retry starts a fresh run;
6. report citations and printer sources open the same drawer;
7. Escape/overlay/close button work and focus returns to the trigger;
8. mobile layout returns to document scrolling without clipped content;
9. reduced-motion mode disables sliding and smooth scrolling.

- [x] **Step 5: Mark this plan complete and commit documentation**

Change completed checkboxes in this plan to `[x]`, then run:

```bash
git add docs/architecture.md docs/superpowers/plans/2026-07-15-structured-research-printer.md
git commit -m "docs: explain the structured printer workflow"
```

## Plan self-review

- Every accepted requirement in `docs/superpowers/specs/2026-07-15-structured-research-printer-design.md` maps to Tasks 1–6.
- The plan does not modify the server Agent, NDJSON schema, providers, prompts, or Tavily.
- `PrinterRecord`, `ResearchPrinter`, `SourceDrawer`, `retry`, and `canRetry` names remain consistent across tasks.
- All production behavior begins with a focused failing test and an observed RED result.
- Chinese comments are limited to design reasons, security boundaries, focus/scroll invariants, and learning value.
