# Scroll Boundary Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep independent desktop scrolling for the left progress column and right workspace while removing every nested vertical scroll container from the normal right-side document flow.

**Architecture:** `.progress-panel` and `.workspace-content` remain the only persistent desktop vertical scroll owners. `ResearchPrinter` becomes a pure record renderer; `ResearchWorkbench` owns the right viewport ref, follow/pause state, “Back to latest progress” control, and one-time report-top positioning. The source drawer remains an intentional temporary modal scroll surface.

**Tech Stack:** Next.js 16.2 App Router, React 19.2, TypeScript 5, Vitest 4, Testing Library, global CSS with Tailwind v4 import, native scroll APIs.

---

## Current worktree prerequisite

The worktree already contains an uncommitted, verified fix in `app/globals.css`, `app/workspace-layout.test.ts`, `components/research/research-printer.tsx`, and `components/research/research-printer.test.tsx`. It establishes the bounded Grid row and visible printer animation. Task 1 preserves that RED → GREEN work as a separate baseline commit; do not reset it or silently fold it into later tasks.

## File map

| Path | Responsibility |
| --- | --- |
| `app/globals.css` | Keep the fixed two-column height chain, remove nested vertical overflow, style the right-side follow button |
| `app/workspace-layout.test.ts` | Static CSS contract for exactly two persistent desktop vertical scroll owners |
| `components/research/research-printer.tsx` | Render printer records and source actions without owning scroll state |
| `components/research/research-printer.test.tsx` | Verify printer semantics, source selection, latest-record marker, and absence of internal follow UI |
| `components/research/research-workbench.tsx` | Own the right viewport ref, follow/pause behavior, report-top transition, and follow button |
| `components/research/research-workbench.test.tsx` | Exercise right-workspace scrolling through DOM properties and rerenders |

## Task 1: Preserve the verified containment and animation baseline

**Files:**

- Verify: `app/globals.css`
- Verify: `app/workspace-layout.test.ts`
- Verify: `components/research/research-printer.tsx`
- Verify: `components/research/research-printer.test.tsx`

- [x] **Step 1: Review the existing uncommitted scope**

Run:

```bash
git status --short
git diff -- app/globals.css components/research/research-printer.tsx components/research/research-printer.test.tsx app/workspace-layout.test.ts
```

Expected: only the verified Grid containment, latest-record marker, paper-feed/report animation, and regression tests appear. Documentation must not enter this code commit.

- [x] **Step 2: Re-run the baseline verification**

```bash
npm test -- app/workspace-layout.test.ts components/research/research-printer.test.tsx
npm run typecheck
git diff --check
```

Expected: 2 focused test files and 5 tests pass; typecheck and diff check exit 0.

- [x] **Step 3: Commit only the baseline slice**

```bash
git add app/globals.css app/workspace-layout.test.ts components/research/research-printer.tsx components/research/research-printer.test.tsx
git diff --cached --check
git commit -m "fix: contain workspace scrolling and reveal records"
```

## Task 2: Remove nested vertical overflow from the right document flow

**Files:**

- Modify: `app/workspace-layout.test.ts`
- Modify: `app/globals.css`

- [x] **Step 1: Write the failing CSS ownership contract**

Append to `app/workspace-layout.test.ts`:

```ts
it("keeps printer and code content in the right workspace document flow", () => {
  const printerRule = styles.match(/\.printer-viewport\s*\{([^}]*)\}/)?.[1] ?? "";
  const preRule = styles.match(/\.event-card pre\s*\{([^}]*)\}/)?.[1] ?? "";

  expect(printerRule).not.toMatch(/max-height/);
  expect(printerRule).toMatch(/overflow-y:\s*visible/);
  expect(printerRule).not.toMatch(/overscroll-behavior/);
  expect(preRule).not.toMatch(/max-height/);
  expect(preRule).toMatch(/overflow:\s*visible/);
  expect(preRule).not.toMatch(/overflow-x:\s*auto/);
  expect(preRule).not.toMatch(/overflow-y:\s*auto/);
});
```

- [x] **Step 2: Run the test and verify RED**

```bash
npm test -- app/workspace-layout.test.ts
```

Expected: FAIL because the printer and `pre` rules still create bounded vertical overflow.

- [x] **Step 3: Implement the minimal CSS change**

Replace the affected rules in `app/globals.css`:

```css
.event-card pre {
  padding: 12px;
  overflow: visible;
  border-radius: 8px;
  background: #eef0ec;
  color: #28332f;
  font: 0.68rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 右侧工作区统一拥有纵向滚动；打印流只是其中的普通文档内容。 */
.printer-viewport {
  overflow-x: visible;
  overflow-y: visible;
}
```

- [x] **Step 4: Verify GREEN and commit**

```bash
npm test -- app/workspace-layout.test.ts
git add app/globals.css app/workspace-layout.test.ts
git diff --cached --check
git commit -m "fix: remove nested workspace scroll regions"
```

Expected: CSS contract tests pass and the commit contains two files.

## Task 3: Make ResearchPrinter scroll-agnostic

**Files:**

- Modify: `components/research/research-printer.test.tsx`
- Modify: `components/research/research-printer.tsx`

- [x] **Step 1: Replace the obsolete follow test with a failing ownership test**

Remove `pauses following when the reader leaves the bottom and resumes on request` and add:

```tsx
it("does not own scrolling or render an internal follow control", () => {
  render(<ResearchPrinter records={records} onSourceSelect={vi.fn()} />);
  const process = screen.getByRole("region", { name: /research process/i });
  Object.defineProperties(process, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(process);

  expect(screen.queryByRole("button", { name: /back to latest progress/i })).not.toBeInTheDocument();
});
```

- [x] **Step 2: Run the focused test and verify RED**

```bash
npm test -- components/research/research-printer.test.tsx
```

Expected: FAIL because the current printer renders its internal follow button after the scroll event.

- [x] **Step 3: Remove internal scroll ownership**

In `components/research/research-printer.tsx`:

- replace the React hooks import with only the `PrinterRecord` type import;
- delete `BOTTOM_THRESHOLD_PX`, `viewportRef`, `followingLatest`, `scrollToLatest`, and `useLayoutEffect`;
- remove `ref` and `onScroll` from `.printer-viewport`;
- delete the internal latest button block;
- preserve the region label, `data-latest`, record details, and source callbacks.

The viewport opening tag must become:

```tsx
<div
  className="printer-viewport"
  role="region"
  aria-label="Research process"
>
```

- [x] **Step 4: Verify GREEN and commit**

```bash
npm test -- components/research/research-printer.test.tsx app/workspace-layout.test.ts
git add components/research/research-printer.tsx components/research/research-printer.test.tsx
git diff --cached --check
git commit -m "refactor: move scrolling out of research printer"
```

Expected: both test files pass; source selection and newest-record animation tests remain green.

## Task 4: Move follow and report positioning to the right workspace

**Files:**

- Modify: `components/research/research-workbench.test.tsx`
- Modify: `components/research/research-workbench.tsx`
- Modify: `app/globals.css`

- [x] **Step 1: Add a right-viewport test helper**

Add below the mocked run declaration in `research-workbench.test.tsx`:

```tsx
function defineWorkspaceScroll(viewport: HTMLElement, scrollTop = 690) {
  const scrollTo = vi.fn();
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
    scrollTo: { configurable: true, value: scrollTo },
  });
  return scrollTo;
}
```

- [x] **Step 2: Write failing pause/resume and report-top tests**

Add inside `describe("ResearchWorkbench", ...)`:

```tsx
it("pauses workspace following while the reader reviews earlier records", () => {
  mockedRun = { status: "running", events: completedEvents.slice(0, 4) };
  const { rerender } = render(<ResearchWorkbench />);
  const viewport = screen.getByRole("region", { name: /research workspace content/i });
  const scrollTo = defineWorkspaceScroll(viewport, 200);
  fireEvent.scroll(viewport);
  expect(screen.getByRole("button", { name: /back to latest progress/i })).toBeInTheDocument();
  scrollTo.mockClear();

  mockedRun = { status: "running", events: [...completedEvents.slice(0, 4), { type: "conclusion.updated", summary: "New evidence" }] };
  rerender(<ResearchWorkbench />);
  expect(scrollTo).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /back to latest progress/i }));
  expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
});

it("positions a newly completed report at the workspace top", () => {
  mockedRun = { status: "running", events: completedEvents.slice(0, -1) };
  const { rerender } = render(<ResearchWorkbench />);
  const viewport = screen.getByRole("region", { name: /research workspace content/i });
  const scrollTo = defineWorkspaceScroll(viewport);
  scrollTo.mockClear();

  mockedRun = { status: "completed", events: completedEvents };
  rerender(<ResearchWorkbench />);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
});
```

- [x] **Step 3: Add the failing near-bottom follow test**

```tsx
it("follows new records when the workspace remains near the bottom", () => {
  mockedRun = { status: "running", events: completedEvents.slice(0, 4) };
  const { rerender } = render(<ResearchWorkbench />);
  const viewport = screen.getByRole("region", { name: /research workspace content/i });
  const scrollTo = defineWorkspaceScroll(viewport, 690);
  fireEvent.scroll(viewport);
  scrollTo.mockClear();

  mockedRun = { status: "running", events: [...completedEvents.slice(0, 4), { type: "conclusion.updated", summary: "New evidence" }] };
  rerender(<ResearchWorkbench />);
  expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
});
```

- [x] **Step 4: Run the tests and verify RED**

```bash
npm test -- components/research/research-workbench.test.tsx
```

Expected: FAIL because the named right workspace region and outer follow control do not exist.

- [x] **Step 5: Implement right-workspace ownership**

Change the React import to include `useCallback` and `useLayoutEffect`, define `BOTTOM_THRESHOLD_PX = 48`, and add these members inside `ResearchWorkbench`:

```tsx
const workspaceRef = useRef<HTMLDivElement>(null);
const previousReportFirst = useRef(false);
const [followingLatest, setFollowingLatest] = useState(true);

const scrollWorkspace = useCallback((top: number) => {
  workspaceRef.current?.scrollTo?.({ top, behavior: "auto" });
}, []);
```

After deriving `active` and `reportFirst`, add:

```tsx
useLayoutEffect(() => {
  const enteredReport = reportFirst && !previousReportFirst.current;
  if (enteredReport) {
    // 完成态改变了内容顺序；只在首次进入时把报告标题带回视野。
    scrollWorkspace(0);
  } else if (active && followingLatest) {
    // 展示跟随不能参与事件消费或业务阶段推进。
    const viewport = workspaceRef.current;
    if (viewport) scrollWorkspace(viewport.scrollHeight);
  }
  previousReportFirst.current = reportFirst;
}, [active, followingLatest, reportFirst, run.events.length, scrollWorkspace]);
```

Reset following only in user event handlers: the idle form submit wrapper sets it before `start`, Retry sets it before `retry`, and New research sets it before `reset`. Do not reset state inside an effect; this keeps the transition lint-safe under `react-hooks/set-state-in-effect`.

- [x] **Step 6: Wrap the right scroll owner and move the button**

Use this structure around the existing report/printer conditional:

```tsx
<div className="workspace-content-shell">
  <div
    ref={workspaceRef}
    className="workspace-content"
    role="region"
    aria-label="Research workspace content"
    onScroll={(event) => {
      const node = event.currentTarget;
      setFollowingLatest(node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD_PX);
    }}
  >
    {reportFirst && view.report ? (
      <>
        <ResearchReportView
          report={view.report}
          sources={view.sources}
          citationNumbers={view.citationNumbers}
          onCitation={setSelectedSourceId}
        />
        {/* 完成态优先阅读结论，失败态优先诊断过程，所以只有前者自动折叠打印记录。 */}
        <details className="process-archive">
          <summary>View research process</summary>
          {printer}
        </details>
      </>
    ) : printer}
  </div>
  {!reportFirst && !followingLatest ? (
    <button className="latest-button" type="button" onClick={() => setFollowingLatest(true)}>
      Back to latest progress
    </button>
  ) : null}
</div>
```

- [x] **Step 7: Add wrapper CSS**

```css
.workspace-content-shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
}
```

Keep `.workspace-content { height: 100%; overflow-y: auto; }`. In the `max-width: 960px` media query add `.workspace-content-shell { height: auto; }`.

- [x] **Step 8: Verify GREEN and commit**

```bash
npm test -- components/research/research-workbench.test.tsx components/research/research-printer.test.tsx app/workspace-layout.test.ts
git add components/research/research-workbench.tsx components/research/research-workbench.test.tsx app/globals.css
git diff --cached --check
git commit -m "feat: follow research from the workspace viewport"
```

Expected: all focused tests pass; the workspace owns pause/resume and report-top behavior.

## Task 5: Browser QA and complete verification

**Files:**

- Verify: `app/globals.css`
- Verify: `components/research/research-workbench.tsx`
- Verify: `components/research/research-printer.tsx`

- [x] **Step 1: Read the applicable Next.js 16 local guides**

```bash
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/01-getting-started/11-css.md
```

Expected: `ResearchWorkbench` remains the explicit client boundary; global CSS remains imported from the root layout.

- [x] **Step 2: Start exactly one current-source development server**

```bash
npm run dev
```

Expected: one Next development server. Stop stale `next start` or duplicate dev processes before evaluating HMR.

- [x] **Step 3: Verify desktop ownership in the browser**

At a viewport wider than 960px, confirm:

```text
.progress-panel        overflow-y: auto
.workspace-content     overflow-y: auto
.printer-viewport      overflow-y: visible
.event-card pre        overflow: visible
```

Expand Plan details until right content is taller than its viewport. With the pointer over a printer card, only `.workspace-content.scrollTop` may change; `.printer-viewport.scrollTop` must stay 0. With the pointer over the left panel, only `.progress-panel.scrollTop` may change.

- [x] **Step 4: Verify follow, report, drawer, and mobile behavior**

Confirm new records follow while near the bottom, pause after the reader scrolls upward, resume via the button, and position a newly completed report at the top. Open the source drawer and confirm background lock plus drawer-only scrolling. At 960px or narrower, confirm the browser page is the only persistent vertical scroll owner.

- [x] **Step 5: Run complete automated verification**

```bash
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass; lint, TypeScript, build, and diff check exit 0. If Turbopack reports `binding to a port: Operation not permitted`, rerun only `npm run build` with sandbox approval.

- [x] **Step 6: Review final history and worktree**

```bash
git log -5 --oneline
git status --short
```

Expected: the baseline, nested-scroll removal, printer simplification, and workspace-follow behavior are separate explainable commits; `.superpowers/` remains untracked and ignored.

### Task 5 verification record

- Desktop (1440 × 900): `.progress-panel` and `.workspace-content` computed to `overflow-y: auto`; `.printer-viewport` computed to `overflow-y: visible`. The live run did not render an `.event-card pre`, so that rule remains covered by the CSS contract test rather than a computed-style browser observation.
- After expanding Plan details, a wheel gesture over the printer changed only `.workspace-content.scrollTop` (`0 → 450`); `.printer-viewport.scrollTop` and `.progress-panel.scrollTop` stayed `0`. A wheel gesture over the left panel then changed only `.progress-panel.scrollTop` (`0 → 400`).
- While following was paused, live records increased from 5 to 8 and `.workspace-content.scrollTop` stayed `450`. “Back to latest progress” moved the workspace to within 1 px of the bottom. When the partial report arrived, the workspace moved to `scrollTop: 0` once.
- Source drawer (1440 × 500): `body` computed to `overflow: hidden`; the drawer computed to `overflow-y: auto` and scrolled `0 → 235` while the background workspace position stayed unchanged.
- Mobile (900 × 800): the shell, progress panel, workspace wrapper, workspace content, and printer all computed to visible overflow with auto height. `documentElement.scrollHeight` was `3514` for an `800` px viewport, making the page the persistent vertical scroll owner.
- The live provider completed a partial report. Chrome logged a hydration warning caused by an extension-injected `trancy-version` attribute on `<html>`; the mismatch was not emitted by application markup.
- Terminal-follow regression after `89a3442`: with following enabled, live records grew from 2 to 5 while `.workspace-content` grew from `647` to `1301` px; `scrollTop` moved from `0` to `653.5` and remained `0.5` px from the bottom. This directly verifies that new records still follow after the viewport becomes scrollable.
- Expanding Plan details grew the workspace from `647` to `789` px and created a `142` px bottom distance, so “Back to latest progress” appeared. While paused, records later grew from 2 to 6 and `scrollHeight` from `789` to `1357`, but `scrollTop` stayed `0`; new records did not take the reader's position. Collapsing reduced `scrollHeight` to `1085`, but the remaining `510` px distance was still outside the threshold, so this live run required the button to resume (`scrollTop: 0 → 510`, distance `0`). The automated ResizeObserver test covers the complementary case where collapsing alone returns within the threshold and restores following.
- A live provider failure arrived while the expanded details had already paused following: the failed record was appended without changing `scrollTop`. The `following=true` failed-terminal path remains covered by the parameterized workbench test because provider timing did not reproduce that exact state.
- Before `621ee2d`, cancelling incremented the client generation immediately, so the live QA correctly observed a cancelled status without a `research.cancelled` printer event. After the local terminal-event fix, a second live run verified the complete path: immediately before Stop, records / `scrollHeight` / `scrollTop` / bottom distance were `5 / 1234 / 587 / 0`; immediately after Stop they were `6 / 1331 / 683 / 1`. The newest card read “Research · cancelled — Research stopped before completion.” and its bottom (`847.3`) remained inside the workspace bottom (`876`); the status read “Research cancelled. Latest event: Research cancelled.” This supersedes the old current-state limitation while preserving why the earlier observation was valid for the previous commit.
- The regression console check again found only the Chrome extension-injected `trancy-version` hydration mismatch; no application-originated warning or error was observed.
- Current regression verification: 18 test files / 291 tests passed. The earlier Task 5 lint and TypeScript checks exited 0, and its production build succeeded after rerunning outside the sandbox because Turbopack's CSS worker needs to bind an internal port.
