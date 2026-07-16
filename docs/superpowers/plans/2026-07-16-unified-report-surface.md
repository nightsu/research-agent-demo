# Unified Draft and Final Report Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the streaming Draft look like the final research report from its first delta, while preserving Streamdown, strict final-report rendering, citation safety, and the existing single-scroll-owner behavior.

**Architecture:** Introduce a presentation-only `ReportShell` that owns the stable outer `<article>` classes and phase marker. `StreamingReportDraft` and `ResearchReportView` keep separate inner renderers, but both render inside this shell; CSS then maps Draft Markdown headings to the corresponding final-report typography. No transport, provider, state, or scroll-controller code changes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Streamdown 2.5, React Markdown, global CSS, Vitest, React Testing Library

---

## File map

| File | Responsibility |
| --- | --- |
| `components/research/report-shell.tsx` | Stable report-paper article, shared phase marker and pass-through semantic attributes |
| `components/research/report-shell.test.tsx` | Shell class composition and DOM-attribute contract |
| `components/research/research-report.tsx` | Final structured renderer inside `ReportShell` |
| `components/research/research-report.test.tsx` | Final renderer retains animation and gains final-phase shell contract |
| `components/research/streaming-report-draft.tsx` | Streamdown renderer inside `ReportShell`, with compact eyebrow/status metadata |
| `components/research/streaming-report-draft.test.tsx` | Draft shell, accessibility, state, and Streamdown contract |
| `app/globals.css` | One report-paper source plus Draft-to-final typography mapping |
| `app/workspace-layout.test.ts` | Static CSS contract for surface reuse, heading parity, and scroll containment |
| `docs/architecture.md` | Learning-oriented explanation of shared shell versus dual renderer responsibilities |

## Task 1: Add the presentation-only ReportShell

**Files:**
- Create: `components/research/report-shell.tsx`
- Create: `components/research/report-shell.test.tsx`

- [ ] **Step 1: Write the failing shell contract test**

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReportShell } from "./report-shell";

afterEach(cleanup);

describe("ReportShell", () => {
  it("composes the shared surface and phase class while forwarding article semantics", () => {
    render(
      <ReportShell
        phase="draft"
        className="streaming-report-draft"
        aria-label="Research report draft"
        aria-busy="true"
      >
        Draft body
      </ReportShell>,
    );

    const article = screen.getByRole("article", { name: "Research report draft" });
    expect(article).toHaveClass(
      "research-report",
      "report-shell-draft",
      "streaming-report-draft",
    );
    expect(article).toHaveAttribute("data-report-phase", "draft");
    expect(article).toHaveAttribute("aria-busy", "true");
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- components/research/report-shell.test.tsx
```

Expected: FAIL because `./report-shell` does not exist.

- [ ] **Step 3: Implement the minimal shell**

```tsx
import type { ComponentPropsWithoutRef } from "react";

type ReportPhase = "draft" | "final";

export interface ReportShellProps extends ComponentPropsWithoutRef<"article"> {
  phase: ReportPhase;
}

export function ReportShell({
  phase,
  className,
  children,
  ...articleProps
}: ReportShellProps) {
  // Shell 只稳定报告纸的 DOM 与视觉边界；内容、安全策略和滚动仍由各自组件负责。
  const classes = ["research-report", `report-shell-${phase}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      {...articleProps}
      className={classes}
      data-report-phase={phase}
    >
      {children}
    </article>
  );
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- components/research/report-shell.test.tsx`

Expected: 1 test passes.

- [ ] **Step 5: Commit the shell**

```bash
git add components/research/report-shell.tsx components/research/report-shell.test.tsx
git commit -m "feat: add shared research report shell"
```

## Task 2: Move the final structured report into ReportShell

**Files:**
- Modify: `components/research/research-report.tsx`
- Modify: `components/research/research-report.test.tsx`

- [ ] **Step 1: Extend the final renderer test first**

Add these assertions to the existing `sets data-animate` parameterized test after locating `.research-report`:

```tsx
const article = container.querySelector(".research-report");
expect(article).toHaveClass("report-shell-final");
expect(article).toHaveAttribute("data-report-phase", "final");
expect(article).toHaveAttribute("data-animate", marker);
```

Replace the existing standalone `data-animate` assertion with the assertions above so the test has one article lookup.

- [ ] **Step 2: Run the final renderer test and verify RED**

Run:

```bash
npm test -- components/research/research-report.test.tsx
```

Expected: FAIL because the article lacks `report-shell-final` and `data-report-phase="final"`.

- [ ] **Step 3: Wrap the final renderer with ReportShell**

Add:

```tsx
import { ReportShell } from "./report-shell";
```

Replace only the outer article tags:

```tsx
<ReportShell
  phase="final"
  data-animate={animate}
  aria-labelledby="report-title"
>
  {/* existing eyebrow, title and sections stay unchanged */}
</ReportShell>
```

Do not move citation handling, Markdown components, section lists, or `report-title` ownership into the shell.

- [ ] **Step 4: Run report tests and verify GREEN**

Run:

```bash
npm test -- components/research/report-shell.test.tsx components/research/research-report.test.tsx
```

Expected: both test files pass, including citation interaction and `data-animate` coverage.

- [ ] **Step 5: Commit the final renderer migration**

```bash
git add components/research/research-report.tsx components/research/research-report.test.tsx
git commit -m "refactor: render final report in shared shell"
```

## Task 3: Move Streamdown Draft into the same shell

**Files:**
- Modify: `components/research/streaming-report-draft.tsx`
- Modify: `components/research/streaming-report-draft.test.tsx`

- [ ] **Step 1: Add failing Draft surface and metadata assertions**

In the first `StreamingReportDraft` test, replace the article/status assertions with:

```tsx
expect(article).toHaveClass(
  "research-report",
  "report-shell-draft",
  "streaming-report-draft",
);
expect(article).toHaveAttribute("data-report-phase", "draft");
expect(article).toHaveAttribute("aria-label", "Research report draft");
expect(article).toHaveAttribute("aria-busy", "true");
expect(screen.getByText("Research report")).toHaveClass("eyebrow");
expect(screen.getByText("正在生成报告草稿").closest(".report-meta")).toBeVisible();
```

Keep the existing no-live-region and Streamdown-prop assertions unchanged.

- [ ] **Step 2: Run the Draft test and verify RED**

Run:

```bash
npm test -- components/research/streaming-report-draft.test.tsx
```

Expected: FAIL because Draft does not yet use the shared shell or render the eyebrow/meta row.

- [ ] **Step 3: Implement the Draft shell and compact metadata row**

Add:

```tsx
import { ReportShell } from "./report-shell";
```

Replace the outer article and standalone status paragraph with:

```tsx
<ReportShell
  phase="draft"
  className="streaming-report-draft"
  aria-label="Research report draft"
  aria-busy={isBusy}
>
  {/* 正式稿和草稿共享同一元信息起点，完成替换时不会像换了一张纸。 */}
  <div className="report-meta">
    <p className="eyebrow">Research report</p>
    <p className={`draft-status draft-status-${draft.status}`}>
      {draftStatusText[draft.status]}
    </p>
  </div>
  <Streamdown
    className="streaming-report-draft-body"
    mode="streaming"
    isAnimating={isStreaming}
    caret="block"
    controls={false}
    skipHtml
    rehypePlugins={draftRehypePlugins}
    components={streamdownDraftComponents}
  >
    {draft.markdown}
  </Streamdown>
</ReportShell>
```

Keep the inert link, removed image, empty rehype plugin list, busy-state rule, and Streamdown configuration unchanged.

- [ ] **Step 4: Run Draft and integration tests and verify GREEN**

Run:

```bash
npm test -- components/research/streaming-report-draft.test.tsx components/research/streaming-report-draft.integration.test.tsx components/research/research-workbench.test.tsx
```

Expected: all three files pass; existing cancellation, replacement, and scroll-follow behavior remains intact.

- [ ] **Step 5: Commit the Draft migration**

```bash
git add components/research/streaming-report-draft.tsx components/research/streaming-report-draft.test.tsx
git commit -m "feat: present streaming draft as final report"
```

## Task 4: Unify report-paper CSS and corresponding heading levels

**Files:**
- Modify: `app/globals.css`
- Modify: `app/workspace-layout.test.ts`

- [ ] **Step 1: Write the failing CSS contract test**

Add this test next to `keeps the streaming draft in the existing workspace scroll flow`:

```ts
it("uses the final report surface and heading hierarchy for the streaming draft", () => {
  const draft = ruleBody(".streaming-report-draft");
  const reportMeta = ruleBody(".report-meta");

  // 外壳尺寸只允许由 .research-report 定义，避免 Draft/Final 再次产生两套纸张。
  expect(draft).not.toMatch(/(?:max-width|padding|border|border-radius|background)\s*:/);
  expect(reportMeta).toMatch(/display:\s*flex;/);
  expect(reportMeta).toMatch(/justify-content:\s*space-between;/);
  expect(styles).toMatch(
    /\.research-report\s*>\s*h2,\s*\.streaming-report-draft-body\s+h1\s*\{/,
  );
  expect(styles).toMatch(
    /\.research-report\s+section\s*>\s*h3,\s*\.streaming-report-draft-body\s+h2\s*\{/,
  );
});
```

- [ ] **Step 2: Run the CSS contract and verify RED**

Run:

```bash
npm test -- app/workspace-layout.test.ts
```

Expected: FAIL because `.streaming-report-draft` still owns duplicate surface dimensions and no `.report-meta` rule exists.

- [ ] **Step 3: Replace duplicate Draft surface declarations with shared hierarchy**

Keep `.research-report` as the only width/padding source and reduce the Draft rule to:

```css
.streaming-report-draft { overflow: visible; }
.report-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.report-meta .eyebrow, .report-meta .draft-status { margin: 0; }
```

Change the status badge so it remains compact without its old standalone margin:

```css
.draft-status {
  width: fit-content;
  padding: 7px 11px;
  border-radius: 999px;
  background: var(--teal-soft);
  color: var(--teal-dark);
  font-size: 0.76rem;
  font-weight: 750;
  transition: color 160ms ease, background-color 160ms ease;
}
```

Replace the separate final-title and Draft h1 declarations with:

```css
.research-report > h2,
.streaming-report-draft-body h1 {
  margin: 7px 0 34px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2rem, 5vw, 3.35rem);
  font-weight: 500;
  line-height: 1.05;
}
```

Replace the separate final section heading and Draft h2 declarations with:

```css
.research-report section > h3,
.streaming-report-draft-body h2 {
  margin: 30px 0 11px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
  font-family: inherit;
  font-size: 0.82rem;
  font-weight: inherit;
  letter-spacing: 0.09em;
  line-height: inherit;
  text-transform: uppercase;
}
```

Keep Draft h3 as the weaker serif subheading, keep table overflow horizontal-only, and keep all reduced-motion rules.

Add a narrow-screen metadata fallback inside `@media (max-width: 640px)`:

```css
.report-meta { align-items: flex-start; flex-direction: column; gap: 10px; }
```

- [ ] **Step 4: Run CSS and renderer tests and verify GREEN**

Run:

```bash
npm test -- app/workspace-layout.test.ts components/research/report-shell.test.tsx components/research/research-report.test.tsx components/research/streaming-report-draft.test.tsx components/research/streaming-report-draft.integration.test.tsx components/research/research-workbench.test.tsx
```

Expected: all focused tests pass; CSS still exposes no nested vertical scroll owner.

- [ ] **Step 5: Commit the visual parity styles**

```bash
git add app/globals.css app/workspace-layout.test.ts
git commit -m "style: align streaming and final reports"
```

## Task 5: Document, verify, and visually inspect the completed behavior

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-07-16-unified-report-surface.md`

- [x] **Step 1: Update the architecture learning path**

Add this explanation after the current client Streamdown paragraph:

```markdown
`ReportShell` 是 Draft 与正式报告唯一共享的 UI 边界：它只提供报告纸的 `<article>`、phase class 和语义属性透传。Draft 内部继续由 Streamdown 容忍未闭合 Markdown，正式态继续由 `ResearchReportView` 渲染经过校验的 finding、confidence 与可交互引用。共享外壳不等于共享不完整业务结构；这个边界避免为了视觉一致而把半成品引用误当成正式数据。
```

- [x] **Step 2: Run the complete automated verification**

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

Expected: 24 test files pass after adding `report-shell.test.tsx`; lint, typecheck, build, and diff check exit 0. If sandboxed Turbopack fails only with `binding to a port: Operation not permitted`, rerun only `npm run build` with the required approval and record both outcomes.

- [ ] **Step 3: Inspect desktop Draft-to-final continuity in the Browser**

Start one current-source server on a free local port and use the in-app Browser at 1440 × 900. Run a bounded research request and capture:

- Draft outer article contains `research-report report-shell-draft streaming-report-draft`;
- the eyebrow and compact status share one metadata row;
- Draft h1 and h2 visually match final title and section-heading hierarchy;
- real Draft text grows while the provider is still running;
- completion swaps to `report-shell-final` without changing report-paper width, padding, border, or current scroll position;
- final confidence cards and citation buttons appear only after validated completion.

- [ ] **Step 4: Inspect narrow layout and scroll ownership**

At 900 × 800 confirm document/window remains the only persistent vertical owner, the report shell introduces no `overflow-y: auto|scroll`, and the compact metadata stacks without horizontal overflow. Reset the viewport override and stop the server after capture.

- [x] **Step 5: Record evidence and commit documentation**

Append exact test counts, build result, browser dimensions, phase classes, scroll owner, and any provider caveat to this plan's verification section, then run:

```bash
git add docs/architecture.md docs/superpowers/plans/2026-07-16-unified-report-surface.md
git commit -m "docs: explain shared report surface"
```

## Task 5 verification evidence (2026-07-16)

- Automated verification: `npm test` exited 0 with 24/24 test files and 413/413 tests; `npm run lint`, `npm run typecheck`, and `git diff --check` each exited 0.
- Build: the sandboxed `npm run build` failed only at Turbopack's internal `binding to a port: Operation not permitted (os error 1)` boundary. The approved outside-sandbox rerun exited 0: Next.js 16.2.10 compiled, typechecked, generated 5/5 static pages, and finalized `/`, `/_not-found`, and `/api/research`.
- Current-source server: the worktree server reached ready state at `http://127.0.0.1:3217`. Because this worktree had no `.env.local`, the main checkout's existing `.env.local` was loaded into the server process without printing or copying its values.
- Browser limitation: the required in-app Browser returned `Browser is not available: iab`. After following its bootstrap troubleshooting, browser discovery exposed only Chrome; Chrome was not substituted for the explicitly required surface. Consequently no 1440 × 900 or 900 × 800 viewport override was applied, no live provider request was sent, and no Browser console findings were available.
- Desktop evidence boundary: live computed width, padding, border, background, Draft h1/h2 typography, two-measurement Draft growth, pre/post-final `scrollTop`, no-jump replacement, and final-only confidence/citation controls were not observed. Automated coverage confirms the Draft classes `research-report report-shell-draft streaming-report-draft`, `data-report-phase=draft`, `.report-meta` containment and flex/space-between rule, growing Markdown propagation, final `report-shell-final` / `data-report-phase=final`, and interactive known citations; these are not claimed as live visual evidence.
- Narrow evidence boundary and concern: automated CSS coverage confirms document scrolling below 960 px and no `overflow-y: auto|scroll` on the Draft shell/body. However, `.report-meta { align-items: flex-start; flex-direction: column; gap: 10px; }` is declared only inside `@media (max-width: 640px)`, so an exact 900 px CSS viewport would not activate the requested stacked metadata rule. Horizontal overflow was not visually measured. No production change was made in this documentation-only task.
- Cleanup: the viewport was never overridden; the dev server was stopped and port 3217 had no remaining listener.

## Plan self-review

- [x] The plan changes no protocol, provider, report projection, client accumulator, or scroll controller.
- [x] Draft and final keep separate content/security renderers while sharing one presentation-only article.
- [x] The Draft test preserves busy state, no live region, inert links, removed images, and Streamdown streaming behavior.
- [x] CSS tests protect both visual parity and the existing single vertical scroll owner.
- [x] Desktop and narrow Browser checks cover the visual behavior that JSDOM cannot calculate.
- [x] Every production change follows a focused RED → GREEN cycle before the full verification run.
