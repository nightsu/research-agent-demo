# Streaming Research Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the final structured research report as a real, continuously growing Markdown draft, preserve strict report and citation validation, and replace the draft with the existing formal report without changing the workspace scroll ownership.

**Architecture:** AI SDK 6 `streamText` produces `partialOutputStream` snapshots for the existing `reportSchema`. The server projects each partial report into deterministic Markdown and emits append-or-replace NDJSON updates; the client validates sequence numbers, keeps the high-frequency draft outside `run.events`, batches React updates every 40 ms, and renders the draft with standalone Streamdown. The existing `ResearchWorkbench` remains the right scroll owner and swaps the validated `ResearchReportView` into the same document flow.

**Tech Stack:** Next.js 16.2 local App Router conventions, React 19.2, TypeScript 5, AI SDK 6.0, Zod 4, NDJSON `ReadableStream`, standalone `streamdown`, Vitest 4, Testing Library.

---

## Scope and file map

| File | Responsibility |
| --- | --- |
| `lib/agent/report-draft.ts` | Pure partial-report-to-Markdown projection and append/replace diff |
| `lib/agent/report-draft.test.ts` | Projection order, partial fields, citations, append and replace tests |
| `lib/agent/research-events.ts` | Strict `report.delta`, `report.validating` and `report.repairing` public event schemas |
| `lib/agent/research-events.test.ts` | New event parsing, privacy and encoded-size tests |
| `lib/providers/research-model.ts` | AI SDK structured report stream and exactly one hidden repair attempt |
| `lib/providers/research-model.test.ts` | Partial output, final validation, abort and repair tests |
| `lib/agent/research-state.ts` | Legal `synthesis.validating` and `synthesis.repairing` state transitions |
| `lib/agent/research-state.test.ts` | Repairing transition tests |
| `lib/agent/research-agent.ts` | Convert partial reports to delta events and emit workflow stages |
| `lib/agent/research-agent.test.ts` | Normal, repair, failure, abort and event-order tests |
| `lib/server/research-route.ts` | Existing backpressure and terminal guarantees; no new scroll/UI logic |
| `app/api/research/route.test.ts` | Route-level delta ordering, backpressure and cancellation tests |
| `components/research/use-research-stream.ts` | Transient draft accumulator, sequence validation and 40 ms React batching |
| `components/research/use-research-stream.test.tsx` | Append/replace, timers, flush, failure retention and generation isolation |
| `components/research/streaming-report-draft.tsx` | Standalone Streamdown renderer and draft status UI |
| `components/research/streaming-report-draft.test.tsx` | Streaming/static state, link/image safety and accessibility tests |
| `components/research/research-printer-model.ts` | Ignore delta events and mark synthesis as validating or repairing |
| `components/research/research-printer-model.test.ts` | Delta omission and validating/repairing projection tests |
| `components/research/research-workbench.tsx` | Draft/final switch, report-start positioning and follow/pause behavior |
| `components/research/research-workbench.test.tsx` | Report draft layout, follow, completion position and retry tests |
| `components/research/research-report.tsx` | Optional entry animation for non-streaming fallback only |
| `components/research/research-report.test.tsx` | New focused animation marker and citation safety tests |
| `app/globals.css` | Draft, status, caret, completion and reduced-motion styles |
| `app/workspace-layout.test.ts` | No nested scroll and reduced-motion CSS contracts |
| `package.json` / `package-lock.json` | Standalone `streamdown` dependency |
| `docs/architecture.md` | Architecture and learning path update |

The approved specification is `docs/superpowers/specs/2026-07-16-streaming-research-report-design.md`. Do not add assistant-ui packages or replace the custom NDJSON endpoint with `useChat` / `UIMessageStreamResponse`.

## Task 1: Define the report draft projection and public protocol

**Files:**
- Create: `lib/agent/report-draft.ts`
- Create: `lib/agent/report-draft.test.ts`
- Modify: `lib/agent/research-events.ts`
- Modify: `lib/agent/research-events.test.ts`

- [x] **Step 1: Read the repository and framework constraints**

Run:

```bash
sed -n '1,160p' AGENTS.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/11-css.md
```

Expected: the local Next.js 16 guides are readable; implementation follows those files instead of remembered Next.js conventions.

- [x] **Step 2: Write failing projection tests**

Create `lib/agent/report-draft.test.ts` with a real citation map and these cases:

```ts
import { describe, expect, it } from "vitest";

import {
  createReportDraftUpdate,
  reportDraftToMarkdown,
  type PartialResearchReport,
} from "./report-draft";

const citations = new Map([
  ["source-1", 1],
  ["source-2", 2],
]);

describe("report draft projection", () => {
  it("renders only fields that exist and keeps the canonical report order", () => {
    const partial: PartialResearchReport = {
      title: "Streaming reports",
      executiveSummary: "The draft grows from structured output.",
      findings: [{
        claim: "The report remains source backed.",
        sourceIds: ["source-1", "unknown"],
        confidence: "high",
      }],
    };

    const markdown = reportDraftToMarkdown(partial, citations);
    expect(markdown).toContain("# Streaming reports");
    expect(markdown).toContain("## Executive summary");
    expect(markdown).toContain("## Key findings");
    expect(markdown).toContain("[1]");
    expect(markdown).not.toContain("unknown");
    expect(markdown).not.toContain("## Trends");
  });

  it("emits an append update when the next Markdown extends the previous value", () => {
    expect(createReportDraftUpdate("# Title", "# Title\n\nMore")).toEqual({
      mode: "append",
      text: "\n\nMore",
    });
  });

  it("falls back to a replace snapshot when a partial object revises earlier text", () => {
    expect(createReportDraftUpdate("# Old", "# Revised")).toEqual({
      mode: "replace",
      text: "# Revised",
    });
  });

  it("does not emit empty updates", () => {
    expect(createReportDraftUpdate("# Same", "# Same")).toBeUndefined();
  });
});
```

- [x] **Step 3: Write failing protocol tests**

Extend `lib/agent/research-events.test.ts` with strict parsing tests:

```ts
it("accepts report delta, validating and repairing events", () => {
  expect(researchEventSchema.parse({
    type: "report.delta",
    sequence: 0,
    mode: "append",
    text: "# Draft",
  })).toMatchObject({ type: "report.delta", sequence: 0 });
  expect(researchEventSchema.parse({ type: "report.validating" })).toEqual({
    type: "report.validating",
  });
  expect(researchEventSchema.parse({ type: "report.repairing" })).toEqual({
    type: "report.repairing",
  });
});

it.each([
  { type: "report.delta", sequence: -1, mode: "append", text: "x" },
  { type: "report.delta", sequence: 0, mode: "merge", text: "x" },
  { type: "report.delta", sequence: 0, mode: "append", text: "" },
  { type: "report.delta", sequence: 0, mode: "append", text: "x", privateThought: "secret" },
])("rejects an invalid public report update", (event) => {
  expect(() => researchEventSchema.parse(event)).toThrow();
});
```

- [x] **Step 4: Run the new tests to verify RED**

Run:

```bash
npm test -- lib/agent/report-draft.test.ts lib/agent/research-events.test.ts
```

Expected: FAIL because `report-draft.ts`, `report.delta`, `report.validating`, and `report.repairing` do not exist.

- [x] **Step 5: Implement the pure projector and schemas**

Create `PartialResearchReport` with optional top-level fields and optional nested finding fields. Implement deterministic Markdown generation in this order: title, Executive summary, Key findings, Trends, Disagreements, Limitations. Use plain `[n]` citation text from the supplied map and omit unknown IDs. Implement `createReportDraftUpdate(previous, current)` exactly as tested.

Add these strict event branches before terminal events in `researchEventSchema`:

```ts
z.strictObject({
  type: z.literal("report.delta"),
  sequence: z.number().int().nonnegative(),
  mode: z.enum(["append", "replace"]),
  text: z.string().min(1),
}),
z.strictObject({
  type: z.literal("report.validating"),
}),
z.strictObject({
  type: z.literal("report.repairing"),
}),
```

Do not add URLs, raw model JSON, provider errors or private reasoning to the Markdown projector. Add a Chinese comment above append/replace selection explaining that partial structured output usually grows but is not a protocol invariant.

- [x] **Step 6: Run focused tests and static checks**

Run:

```bash
npm test -- lib/agent/report-draft.test.ts lib/agent/research-events.test.ts
npm run typecheck
npm run lint -- lib/agent/report-draft.ts lib/agent/report-draft.test.ts lib/agent/research-events.ts lib/agent/research-events.test.ts
git diff --check
```

Expected: all commands exit 0.

- [x] **Step 7: Commit the protocol slice**

```bash
git add lib/agent/report-draft.ts lib/agent/report-draft.test.ts lib/agent/research-events.ts lib/agent/research-events.test.ts
git commit -m "feat: define streaming report draft protocol"
```

## Task 2: Stream structured reports from the provider

**Files:**
- Modify: `lib/providers/research-model.ts`
- Modify: `lib/providers/research-model.test.ts`

- [x] **Step 1: Write failing provider stream tests**

Update the hoisted AI SDK mock to expose `streamText` and `Output.object`. Add tests that use a controlled async iterable:

```ts
async function* partialReports() {
  yield { title: "Streaming" };
  yield {
    title: "Streaming reports",
    executiveSummary: "The report grows while the model runs.",
  };
}

it("forwards partial structured reports and resolves the validated final report", async () => {
  const onPartialReport = vi.fn();
  const onValidating = vi.fn();
  streamText.mockReturnValue({
    partialOutputStream: partialReports(),
    output: Promise.resolve(report),
  });

  await createResearchModel().generateReport(
    question,
    sources,
    evaluations,
    false,
    { onPartialReport, onValidating },
  );

  expect(onPartialReport.mock.calls).toEqual([
    [{ title: "Streaming" }],
    [{
      title: "Streaming reports",
      executiveSummary: "The report grows while the model runs.",
    }],
  ]);
  expect(onValidating).toHaveBeenCalledTimes(1);
  expect(streamText).toHaveBeenCalledTimes(1);
});
```

Add three more tests:

- final output with an unknown citation rejects before returning;
- a repairable final-output failure calls `onRepairing` once, performs one `generateText` repair, and does not stream repair partials;
- transport or abort failure does not call `onRepairing` or `generateText`, and its raw provider message never enters a public event fixture.

- [x] **Step 2: Run provider tests to verify RED**

Run:

```bash
npm test -- lib/providers/research-model.test.ts
```

Expected: FAIL because the model uses `generateText` only and `ResearchModelOptions` has no report callbacks.

- [x] **Step 3: Add report-specific model options**

Define:

```ts
export interface ResearchReportModelOptions extends ResearchModelOptions {
  onPartialReport?: (partial: PartialResearchReport) => void | Promise<void>;
  onValidating?: () => void | Promise<void>;
  onRepairing?: () => void | Promise<void>;
}
```

Change only `ResearchModel.generateReport` to accept `ResearchReportModelOptions`. Keep Plan, source evaluation and evidence assessment on `ResearchModelOptions`.

- [x] **Step 4: Implement one streaming attempt and one hidden repair**

Use `streamText` with `Output.object({ schema: reportSchema })`. Call `onModelCall` once before starting the stream. Consume `partialOutputStream` with `for await`, await each `onPartialReport`, then await final `output` and call `validateReportCitations`.

After `partialOutputStream` ends, await `onValidating` before awaiting and validating the final output. If and only if `isRepairableStructuredOutputError` matches the final structured-output failure:

1. await `onRepairing`;
2. call the existing non-streaming structured generator exactly once with the repair prompt;
3. call `onModelCall` for that repair provider call;
4. validate citations and return the repaired report.

Transport, authentication, rate-limit and abort failures remain single-call failures. Add a Chinese comment explaining why the second attempt is hidden: replaying a second visible draft would clear or contradict text the user is already reading.

- [x] **Step 5: Run provider tests and checks**

Run:

```bash
npm test -- lib/providers/research-model.test.ts
npm run typecheck
npm run lint -- lib/providers/research-model.ts lib/providers/research-model.test.ts
git diff --check
```

Expected: all commands exit 0; tests prove exactly one normal stream and at most one repair call.

- [x] **Step 6: Commit the provider slice**

```bash
git add lib/providers/research-model.ts lib/providers/research-model.test.ts
git commit -m "feat: stream structured research reports"
```

## Task 3: Emit report draft workflow events through the existing route

**Files:**
- Modify: `lib/agent/research-state.ts`
- Modify: `lib/agent/research-state.test.ts`
- Modify: `lib/agent/research-agent.ts`
- Modify: `lib/agent/research-agent.test.ts`
- Verify: `lib/server/research-route.ts`
- Modify: `app/api/research/route.test.ts`
- Modify: `app/api/research/research-flow.test.ts`

- [x] **Step 1: Write failing validating and repairing transition tests**

Add `synthesis.validating` and `synthesis.repairing` to `ResearchAction` and first write the test:

```ts
it("keeps the workflow synthesizing while a report is repaired", () => {
  const synthesizing = reduceResearchState(evaluatingState, {
    type: "synthesis.started",
    payload: {},
  });
  const validating = reduceResearchState(synthesizing, {
    type: "synthesis.validating",
    payload: {},
  });
  const repairing = reduceResearchState(validating, {
    type: "synthesis.repairing",
    payload: {},
  });
  expect(validating.phase).toBe("synthesizing");
  expect(repairing).not.toBe(synthesizing);
  expect(repairing.phase).toBe("synthesizing");
});
```

- [x] **Step 2: Write failing Agent event-order tests**

Update the test `model()` helper so `generateReport` invokes `onPartialReport` and optionally `onRepairing`. Add these assertions:

```ts
expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
  "report.started",
  "report.delta",
  "report.completed",
]));

const reportEvents = events.filter((event) => event.type.startsWith("report."));
expect(reportEvents.map((event) => event.type)).toEqual([
  "report.started",
  "report.delta",
  "report.delta",
  "report.validating",
  "report.completed",
]);
expect(reportEvents.filter((event) => event.type === "report.delta").map((event) => event.sequence)).toEqual([0, 1]);
```

Add a repair test expecting `report.validating` and then `report.repairing` between the last delta and the terminal report, plus a cancellation test proving no delta is emitted after `research.cancelled`.

- [x] **Step 3: Run state and Agent tests to verify RED**

Run:

```bash
npm test -- lib/agent/research-state.test.ts lib/agent/research-agent.test.ts
```

Expected: FAIL because validating/repairing transitions and partial callbacks are not wired.

- [x] **Step 4: Implement Agent delta emission**

During the existing synthesis stage:

1. build citation numbers from accepted sources;
2. keep `previousMarkdown` and `sequence` local to this report attempt;
3. pass `onPartialReport` to `generateReport`;
4. project each partial value through `reportDraftToMarkdown`;
5. emit no event when the Markdown is unchanged;
6. emit `report.delta` with append or replace and increment sequence only after successful delivery;
7. pass `onValidating` that performs `transition({ type: "synthesis.validating" }, [{ type: "report.validating" }])`;
8. pass `onRepairing` that performs `transition({ type: "synthesis.repairing" }, [{ type: "report.repairing" }])`;
9. preserve the existing completed / partial terminal transition.

Await every callback so the existing route backpressure and event timeout apply to report updates. Add a Chinese comment explaining that delivery acknowledgement must precede sequence increment; otherwise a rejected emit would create a gap the client correctly treats as a protocol error.

- [x] **Step 5: Add route integration coverage**

Extend `app/api/research/route.test.ts` and `app/api/research/research-flow.test.ts` to assert:

- `report.delta` records remain valid one-line NDJSON;
- a slow consumer holds later report updates behind `desiredSize` backpressure;
- cancellation aborts the provider stream and emits no record after the terminal event;
- a complete real workflow contains one `report.started`, at least one `report.delta`, and exactly one completed/partial terminal report;
- `report.delta` is not added to `terminalEventTypes`.

- [x] **Step 6: Run the server-side suite**

Run:

```bash
npm test -- lib/agent/research-state.test.ts lib/agent/research-agent.test.ts app/api/research/route.test.ts app/api/research/research-flow.test.ts
npm run typecheck
npm run lint -- lib/agent/research-state.ts lib/agent/research-agent.ts app/api/research/route.test.ts app/api/research/research-flow.test.ts
git diff --check
```

Expected: all commands exit 0; event order and route backpressure are explicit.

- [x] **Step 7: Commit the workflow slice**

```bash
git add lib/agent/research-state.ts lib/agent/research-state.test.ts lib/agent/research-agent.ts lib/agent/research-agent.test.ts app/api/research/route.test.ts app/api/research/research-flow.test.ts
git commit -m "feat: emit streaming report workflow events"
```

## Task 4: Buffer report drafts in the client stream hook

**Files:**
- Modify: `components/research/use-research-stream.ts`
- Modify: `components/research/use-research-stream.test.tsx`

- [x] **Step 1: Write failing transient-draft reducer tests**

Use fake timers and a real NDJSON `ReadableStream`. Add tests for:

```ts
it("keeps report deltas out of the persistent research event log", async () => {
  const { result } = renderHook(() => useResearchStream());
  await act(() => result.current.start(validRequest));
  await vi.advanceTimersByTimeAsync(40);

  expect(result.current.run.reportDraft?.markdown).toBe("# Draft");
  expect(result.current.run.events.some((event) => event.type === "report.delta")).toBe(false);
});

it("batches rapid append updates into one visible 40ms draft update", async () => {
  expect(result.current.run.reportDraft?.markdown).toBe("");
  await vi.advanceTimersByTimeAsync(39);
  expect(result.current.run.reportDraft?.markdown).toBe("");
  await vi.advanceTimersByTimeAsync(1);
  expect(result.current.run.reportDraft?.markdown).toBe("# Draft grows");
});
```

Also add tests for replace, repeated/skipped/out-of-order sequence, terminal flush, failed/cancelled retention, validating/repairing status, completed cleanup, retry/reset cleanup, late old-generation updates and unmount timer cleanup.

- [x] **Step 2: Run hook tests to verify RED**

Run:

```bash
npm test -- components/research/use-research-stream.test.tsx
```

Expected: FAIL because `ResearchRun` has no `reportDraft` and all events currently enter `run.events`.

- [x] **Step 3: Add transient draft types and accumulator refs**

Define:

```ts
export interface ReportDraftState {
  markdown: string;
  sequence: number;
  status: "streaming" | "validating" | "repairing" | "incomplete";
}
```

Add `reportDraft?: ReportDraftState` and `hadReportDraft: boolean` to internal run state. `hadReportDraft` resets on start/reset, becomes true after a non-empty delta, and remains true through completion so the formal report can suppress duplicate entry animation.

Keep a generation-bound accumulator ref containing `markdown` and `nextSequence`, plus one timer ref. Validate and apply every delta immediately in the ref, but dispatch at most one visible draft update every 40 ms.

- [x] **Step 4: Implement protocol and lifecycle rules**

In `processRecord`:

- parse every event with the existing strict decoder;
- intercept `report.delta` before the normal event reducer;
- require `event.sequence === nextSequence`;
- apply append/replace to the accumulator;
- schedule one 40 ms flush;
- do not dispatch the delta into `run.events`.

For normal events:

- `report.started` creates an empty streaming draft;
- `report.validating` and `report.repairing` remain in `run.events` and change draft status accordingly;
- completed/partial force-flush then clear `reportDraft` while retaining `hadReportDraft`;
- failed/cancelled force-flush and mark an existing draft incomplete;
- retry/reset/new generation clears accumulator and pending timer.

Add Chinese comments at sequence validation, terminal flush and delta-log omission. The comments must explain ordering and ownership, not restate the code.

- [x] **Step 5: Run hook tests and checks**

Run:

```bash
npm test -- components/research/use-research-stream.test.tsx
npm run typecheck
npm run lint -- components/research/use-research-stream.ts components/research/use-research-stream.test.tsx
git diff --check
```

Expected: all commands exit 0 under real and fake timer tests.

- [x] **Step 6: Commit the client stream slice**

```bash
git add components/research/use-research-stream.ts components/research/use-research-stream.test.tsx
git commit -m "feat: buffer streaming report drafts"
```

## Task 5: Render the transient draft with standalone Streamdown

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `components/research/streaming-report-draft.tsx`
- Create: `components/research/streaming-report-draft.test.tsx`
- Modify: `app/globals.css`
- Modify: `app/workspace-layout.test.ts`

- [x] **Step 1: Write a failing renderer test before installing the package**

Create `components/research/streaming-report-draft.test.tsx`. Mock the `streamdown` module with a component that exposes received mode, animation and Markdown. Test:

```ts
it("renders a growing Markdown draft without creating a scroll viewport", () => {
  const { container } = render(
    <StreamingReportDraft draft={{
      markdown: "# Draft\n\nGrowing text",
      sequence: 2,
      status: "streaming",
    }} />,
  );

  expect(screen.getByText("# Draft\n\nGrowing text")).toBeInTheDocument();
  expect(screen.getByTestId("streamdown")).toHaveAttribute("data-mode", "streaming");
  expect(container.querySelector(".streaming-report-draft")).not.toHaveAttribute("aria-live");
});
```

Add tests proving repairing stops animation, incomplete shows an explicit warning, link rendering returns inert text, and image rendering returns `null`.

- [x] **Step 2: Run the renderer test to verify RED**

Run:

```bash
npm test -- components/research/streaming-report-draft.test.tsx
```

Expected: FAIL because the component and `streamdown` dependency do not exist.

- [x] **Step 3: Install only standalone Streamdown**

Run:

```bash
npm install streamdown
```

Expected: `package.json` and `package-lock.json` add `streamdown`; no `@assistant-ui/*` package appears.

- [x] **Step 4: Implement the renderer**

Create `StreamingReportDraft` with these fixed boundaries:

```tsx
<article className="streaming-report-draft" aria-busy={draft.status === "streaming"}>
  <DraftStatus status={draft.status} />
  <Streamdown
    mode="streaming"
    isAnimating={draft.status === "streaming"}
    components={{
      a: ({ children }) => <span>{children}</span>,
      img: () => null,
    }}
  >
    {draft.markdown}
  </Streamdown>
</article>
```

Use visible status text for streaming, validating, repairing and incomplete. Do not add a scroll wrapper, source click handler, raw HTML plugin, image plugin, Mermaid plugin or assistant-ui provider. Add a Chinese comment explaining why the draft body is intentionally not live-announced.

- [x] **Step 5: Add bounded CSS contracts**

Add draft typography and status styles without `height`, `max-height`, `overflow-y: auto` or `overflow: scroll`. Extend reduced-motion rules so Streamdown caret/transition animation is disabled while text updates remain visible.

Extend `app/workspace-layout.test.ts` to assert the draft has visible overflow and the reduced-motion block disables its caret animation.

- [x] **Step 6: Run renderer, CSS and package checks**

Run:

```bash
npm test -- components/research/streaming-report-draft.test.tsx app/workspace-layout.test.ts
npm run typecheck
npm run lint -- components/research/streaming-report-draft.tsx components/research/streaming-report-draft.test.tsx app/workspace-layout.test.ts
npm ls streamdown
rg -n '@assistant-ui/' package.json package-lock.json
git diff --check
```

Expected: tests, static checks, `npm ls streamdown` and `git diff --check` exit 0. The `rg` command exits 1 with no matches, proving assistant-ui packages are absent.

- [x] **Step 7: Commit the renderer slice**

```bash
git add package.json package-lock.json components/research/streaming-report-draft.tsx components/research/streaming-report-draft.test.tsx app/globals.css app/workspace-layout.test.ts
git commit -m "feat: render streaming report drafts"
```

## Task 6: Integrate draft, formal report and workspace scrolling

**Files:**
- Modify: `components/research/research-printer-model.ts`
- Modify: `components/research/research-printer-model.test.ts`
- Modify: `components/research/research-report.tsx`
- Create: `components/research/research-report.test.tsx`
- Modify: `components/research/research-workbench.tsx`
- Modify: `components/research/research-workbench.test.tsx`
- Modify: `app/globals.css`

- [x] **Step 1: Write failing Printer projection tests**

Add tests proving `report.delta` creates no Printer record and validating/repairing update the current synthesis record:

```ts
expect(derivePrinterRecords([
  { type: "report.started", partial: false },
  { type: "report.delta", sequence: 0, mode: "append", text: "# Draft" },
  { type: "report.validating" },
  { type: "report.repairing" },
])).toEqual([{
  id: "synthesis-0",
  kind: "synthesis",
  partial: false,
  status: "repairing",
}]);
```

- [x] **Step 2: Write failing formal-report animation tests**

Add an `animate` prop defaulting to true in the expected API and test:

```ts
const reportProps = {
  report,
  sources: [source],
  onCitation: vi.fn(),
};
const { container, rerender } = render(
  <ResearchReportView {...reportProps} animate />,
);
expect(container.querySelector(".research-report")).toHaveAttribute("data-animate", "true");
rerender(<ResearchReportView {...reportProps} animate={false} />);
expect(container.querySelector(".research-report")).toHaveAttribute("data-animate", "false");
```

Define `report` and `source` in the new test file with the same complete `ResearchReport` and collected `Source` shapes used by `research-workbench.test.tsx`. Include the existing known-link/unknown-link safety assertions in this focused file rather than deleting their Workbench coverage in the same task.

CSS animation selectors must require `[data-animate="true"]` so a streamed draft is not followed by a second fake reveal.

- [x] **Step 3: Write failing Workbench behavior tests**

Extend the hook mock with `reportDraft` and `hadReportDraft`. Add tests for:

- `report.started` draft is the primary right content and Printer is inside a closed process archive;
- entering the report surface scrolls to top exactly once;
- draft Markdown growth scrolls to bottom only while following;
- user scroll-up preserves position across later draft updates;
- the follow button reads “Back to latest report” during a draft;
- repairing keeps the same draft visible;
- failed/cancelled keeps an incomplete draft and terminal Printer record;
- completed replaces draft with `ResearchReportView animate={false}` and does not call `scrollTo(0)`;
- a completed report with no prior delta uses `animate={true}` as fallback;
- retry/new research resets draft-facing UI.

- [x] **Step 4: Run focused UI tests to verify RED**

Run:

```bash
npm test -- components/research/research-printer-model.test.ts components/research/research-report.test.tsx components/research/research-workbench.test.tsx
```

Expected: FAIL because synthesis has no repairing status and Workbench has no draft surface.

- [x] **Step 5: Implement projection and formal report marker**

Extend synthesis status to `running | validating | repairing | complete`. Ignore `report.delta` in `derivePrinterRecords`; update the latest active synthesis record on `report.validating` and `report.repairing`.

Add `animate?: boolean` to `ResearchReportView`, render `data-animate={animate}`, and scope the existing `report-feed` selectors to `[data-animate="true"]`.

- [x] **Step 6: Implement Workbench report-surface ownership**

Define the report surface as an existing `run.reportDraft` or a validated completed/partial report. Render in this order:

1. `StreamingReportDraft` while `run.reportDraft` exists;
2. `ResearchReportView` when a validated report exists;
3. closed process archive below either report surface;
4. Printer as primary content before synthesis starts.

Move the one-time top positioning condition from completed/partial entry to report-surface entry. During draft growth, include draft sequence or Markdown length in the follow effect. On final replacement, neither top-scroll nor bottom-scroll may run solely because validation completed. Keep the existing ResizeObserver on the right document wrapper.

Use `run.hadReportDraft` to set formal report animation. Change only the follow button label based on whether the report surface is active; the right workspace remains its owner.

Add Chinese comments explaining the new top-position timing and why final replacement preserves the reader position.

- [x] **Step 7: Run UI and scroll regression tests**

Run:

```bash
npm test -- components/research/research-printer-model.test.ts components/research/research-report.test.tsx components/research/research-workbench.test.tsx components/research/streaming-report-draft.test.tsx app/workspace-layout.test.ts
npm run typecheck
npm run lint -- components/research/research-printer-model.ts components/research/research-report.tsx components/research/research-workbench.tsx
git diff --check
```

Expected: all commands exit 0; no nested vertical scroll contract changes.

- [x] **Step 8: Commit the integration slice**

```bash
git add components/research/research-printer-model.ts components/research/research-printer-model.test.ts components/research/research-report.tsx components/research/research-report.test.tsx components/research/research-workbench.tsx components/research/research-workbench.test.tsx app/globals.css
git commit -m "feat: integrate streamed reports into workspace"
```

## Task 7: Document, verify and browser-QA the complete stream

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-07-16-streaming-research-report.md`
- Verify: all files from Tasks 1–6

- [x] **Step 1: Update architecture documentation**

Add a “真实报告流” section to `docs/architecture.md` containing:

- one Mermaid diagram from model partial output through formal report replacement;
- the durable `run.events` versus transient `run.reportDraft` boundary;
- append/replace and sequence semantics;
- hidden repair and incomplete-draft behavior;
- why Streamdown is standalone and assistant-ui is not installed;
- the learning order: event schema → provider stream → draft projector → Agent callbacks → NDJSON route → Hook batching → Streamdown → Workbench scroll → formal citation view.

- [x] **Step 2: Run the complete automated verification**

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: all tests pass; lint, TypeScript, production build and diff check exit 0; status contains only the intended documentation update before its commit. If sandboxed Turbopack reports `binding to a port: Operation not permitted`, rerun only `npm run build` with the required sandbox approval and record both outcomes.

- [x] **Step 3: Start one current-source development server**

Use a port not occupied by the original checkout or another worktree:

```bash
npm run dev -- --port 3002
```

Expected: Next.js reports Ready for the implementation worktree. Confirm the browser URL points to that worktree server before collecting evidence.

- [ ] **Step 4: Verify real provider streaming on desktop**

At 1440 × 900, run a research question that produces a long report and capture these facts with browser measurements:

- `report.started` makes the draft surface visible before terminal completion;
- draft text/sequence changes at least three times while status remains running;
- updates are real content changes, not one complete DOM followed by CSS reveal;
- `.workspace-content` remains the right scroll owner and `.streaming-report-draft` has visible overflow;
- while following, increasing draft height keeps bottom distance within 48 px;
- after scrolling upward, later delta updates leave `scrollTop` unchanged and show “Back to latest report”;
- the button restores bottom following;
- formal report replacement does not jump to top and does not replay `report-feed`;
- formal citations still open the source drawer.

- [ ] **Step 5: Verify incomplete, retry, reduced-motion and mobile behavior**

Use Stop research during report streaming and confirm the draft remains with an incomplete label and one cancelled terminal record. Retry and confirm the old Markdown disappears before the new generation starts.

Emulate `prefers-reduced-motion: reduce` and confirm caret/entry animations stop while text continues to update. At 900 × 800, confirm the document remains the only persistent vertical scroll owner and the draft introduces no nested scroll area.

If a provider run does not reach synthesis, record the provider failure explicitly and use deterministic browser fixtures only for the missing UI state; do not describe fixture evidence as a live provider observation.

- [x] **Step 6: Record QA evidence and commit documentation**

Append exact browser dimensions, scrollTop/scrollHeight/clientHeight values, draft sequence changes, completion state, console findings and any provider caveat to the verification section of this plan.

Run:

```bash
git diff --check
git add docs/architecture.md docs/superpowers/plans/2026-07-16-streaming-research-report.md
git commit -m "docs: explain streaming report pipeline"
```

- [ ] **Step 7: Review the complete commit range**

Run:

```bash
git log --oneline --decorate --max-count=12
git status --short --branch
```

Expected: protocol, provider, workflow, client buffering, renderer, workspace integration and documentation are separate explainable commits; the worktree is clean.

Dispatch a fresh final reviewer over the design-doc commit exclusive through current HEAD. The reviewer must inspect every code and documentation commit, rerun full tests/lint/typecheck/build/diff-check, and return Critical/Important/Minor findings plus an explicit Ready verdict before branch completion.

## Task 7 verification evidence (2026-07-16, Asia/Shanghai)

### Automated verification

- `git diff --check`: exit 0 before browser QA.
- `npm test`: exit 0, 22 test files and 394 tests passed.
- `npm run lint`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run build`: the sandboxed first run failed only with Turbopack `creating new process - binding to a port - Operation not permitted (os error 1)`; the approved unsandboxed rerun exited 0, compiled successfully and generated `/`, `/_not-found` and `/api/research`.
- `npm ls streamdown`: exit 0, `streamdown@2.5.0`.
- `rg -n '@assistant-ui/' package.json package-lock.json`: no output and expected exit 1.
- Pre-commit `git status --short`: only `docs/architecture.md` and this plan are intended documentation changes.

### Server and browser boundary

- Port 3002 was free before start. The current worktree server started with the existing main-checkout `.env.local` loaded in-process, without printing or copying secrets, and was bound only to `127.0.0.1:3002`.
- Browser URL was explicitly verified as `http://localhost:3002/`, not an older checkout or port. QA used the Browser plugin's `browser-client` with its `tab.playwright` surface.
- Exact desktop viewport: 1440 × 900. Exact narrow viewport: 900 × 800. The temporary viewport override was reset after QA.

### Live provider evidence

- Four Kimi + Tavily attempts reached real synthesis. They produced actual DOM text changes while the run remained `running`, rather than revealing one complete DOM with CSS: observed draft lengths included `0 → 176 → 1495` on the first run, `0 → 736 → 966 → 1917` on its retry, `0 → 87` on the cancellation run, and `0 → 95 → 1067` on the final bounded completion attempt. `sequence` is intentionally absent from the DOM contract, so Browser could not read a numeric sequence without prohibited page-state injection; deterministic route coverage observed sequences `[0, 1]`, while these increasing live Markdown lengths are the browser evidence for real deltas.
- A live following sample at length 176 measured desktop `.workspace-content` as `scrollTop=112`, `scrollHeight=760`, `clientHeight=647`, `bottomDistance=1`; at length 1495 it measured `609 / 1256 / 647 / 0`. Retry samples measured `261 / 908 / 647 / 0` at length 736 and `452 / 1100 / 647 / 1` at length 966. All are within the 48 px following threshold.
- Computed desktop ownership during a live draft: `.workspace-content { overflow-y: auto }`; `.streaming-report-draft { overflow-y: visible }`. No draft table appeared in these live provider outputs, so the table's horizontal-only overflow remains test evidence rather than a computed browser observation.
- `report.validating` and `report.repairing` both occurred in the live retry; the visible status changed from `正在生成报告草稿` to `正在修复报告草稿` while preserving 1917 characters. They are recorded because they actually occurred, not inferred from static code.
- Desktop PageUp exposed “Back to latest report”; after resume, metrics were `scrollTop=1032`, `scrollHeight=1680`, `clientHeight=647`, `bottomDistance=1` and the button disappeared. The PageUp key itself continued native scrolling during the next measurement (`481` to `404.5`), and the provider entered repair before another delta, so “later delta leaves an already-settled paused scrollTop unchanged” was not claimed from this live run; focused Workbench tests cover that contract.
- Stop was clicked during a live synthesis draft. The terminal UI preserved 87 characters, changed the label to `报告草稿未完成，最终报告尚不可用`, reported `Research cancelled`, and contained exactly one cancelled Printer record. Retry immediately cleared the old Markdown (`draftLength=0`, old heading absent) before the new generation began.
- Live completion caveat: every bounded completion attempt reached synthesis and streamed a draft, but none produced a validated formal report. Outcomes were the public errors `A research dependency failed.` or `A research operation timed out.`; incomplete drafts of 1858 and 1067 characters remained readable. Server output also warned that Kimi `kimi-k2.6` does not support the requested `responseFormat` feature. Therefore formal replacement, `data-animate="false"`, and citation-drawer opening are **not** described as live observations.

### Responsive owner, accessibility and console evidence

- On 900 × 800 after a followed desktop-to-document migration, document metrics were `scrollTop=1393`, `scrollHeight=2193`, `clientHeight=800`, `bottomDistance=0`; `.workspace-content` measured `scrollTop=0`, `scrollHeight=1526`, `clientHeight=1526`, `overflow-y: visible`. `.workspace-shell` and the draft also computed to visible vertical overflow, so document/window was the only persistent vertical owner.
- Mobile PageUp produced document metrics `196 / 2193 / 800 / 1197`, showed a `position: fixed` “Back to latest report” button, and left workspace `scrollTop=0`. Clicking the button restored document `1393 / 2193 / 800 / 0`. Resizing back across 960 px restored desktop workspace ownership at `1107 / 1682 / 575 / 0`, with document `0 / 900 / 900`.
- The available Browser runtime exposes viewport override but no reduced-motion emulation capability. Reduced-motion caret/entry suppression with continued text updates is therefore covered by `app/workspace-layout.test.ts` and renderer/Workbench tests, not claimed as a browser observation.
- Browser console contained one hydration mismatch from the user's Chrome extension injecting `trancy-version="7.8.9"` on `<html>`; the diff identifies the external attribute, not application markup. No other browser warning/error was captured. Server logs contained the Kimi `responseFormat` compatibility warning noted above.
- No deterministic browser fixture was injected: the production page has no fixture entry point, and the required Browser surface exposes read-only page evaluation. Mutating `fetch` or React state from page code would violate the Browser contract. Automated deterministic route, Hook, Workbench, report and citation tests supply the missing completion/citation/reduced-motion evidence; this limitation is kept explicit rather than presenting test evidence as live QA.
- Browser tabs were finalized, the viewport override was reset, the development server was stopped, and `lsof -nP -iTCP:3002 -sTCP:LISTEN` returned no listener (exit 1).

## Plan self-review checklist

- [x] Every confirmed specification section maps to Tasks 1–7.
- [x] No assistant-ui dependency, `useChat`, Thread Runtime or new nested scroll viewport is introduced.
- [x] Normal report generation performs one model call; only a repairable final validation failure permits one hidden repair call.
- [x] `report.delta` is strict transport data but does not enter client `run.events`.
- [x] Completion keeps reading position; report-start owns the one-time top positioning.
- [x] Failure and cancellation preserve the latest flushed draft.
- [x] Security tests cover raw errors, links, images, unknown citations and private fields.
- [x] Every implementation task starts with a failing test, proves RED, implements the minimum, proves GREEN and commits separately.
