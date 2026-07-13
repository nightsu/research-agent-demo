# Research Operation Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase the default per-operation research deadline from 30 seconds to 120 seconds.

**Architecture:** Keep timeout ownership in `lib/agent/limits.ts`. Both quick and deep modes continue sharing the inherited default, while the existing request timeout schema and route-level 300-second duration remain unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js 16.2.10

## Global Constraints

- The operation timeout must be exactly `120_000` milliseconds.
- `app/api/research/route.ts` must retain `maxDuration = 300`.
- Public timeout error mapping must remain unchanged.
- Do not introduce new environment variables or dependencies.

---

### Task 1: Increase and document the shared research timeout

**Files:**
- Modify: `lib/agent/limits.ts`
- Modify: `lib/agent/research-agent.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `defaultResearchLimits`, `quickResearchLimits`, and `researchLimitsSchema` from `lib/agent/limits.ts`.
- Produces: a shared `requestTimeoutMs` default of `120_000` for quick and deep research operations.

- [ ] **Step 1: Write the failing test**

Add a test that imports the limit exports and asserts the desired default and inheritance:

```ts
it("uses the maximum allowed timeout for quick and deep research", () => {
  expect(defaultResearchLimits.requestTimeoutMs).toBe(120_000);
  expect(quickResearchLimits.requestTimeoutMs).toBe(120_000);
  expect(researchLimitsSchema.safeParse(defaultResearchLimits).success).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run lib/agent/research-agent.test.ts
```

Expected: FAIL because the current default is `30_000`.

- [ ] **Step 3: Implement the minimal timeout change**

Change the default in `lib/agent/limits.ts`:

```ts
requestTimeoutMs: 120_000,
```

- [ ] **Step 4: Update the documentation**

Change README's runtime-limit description from 30 seconds to 120 seconds, without changing the quick/deep operation or search-round limits.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
npx vitest run lib/agent/research-agent.test.ts
npm test
npm run typecheck
```

Expected: all commands exit successfully with no test failures or TypeScript errors.

- [ ] **Step 6: Review the diff**

Run:

```bash
git diff -- lib/agent/limits.ts lib/agent/research-agent.test.ts README.md
```

Expected: only the timeout assertion, default value, and README timeout description change.
