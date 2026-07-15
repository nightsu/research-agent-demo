import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

function ruleBody(selector: string, source = styles) {
  const uncommentedSource = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(uncommentedSource)) !== null) {
    const selectors = match[1].split(",").map((entry) => entry.trim());
    if (selectors.includes(selector)) return match[2];
  }

  expect.fail(`Missing CSS rule for ${selector}`);
}

describe("desktop research workspace layout", () => {
  it("stretches the right column into a bounded independent scroll viewport", () => {
    // JSDOM 不计算真实网格尺寸；这条契约测试防止桌面滚动所依赖的 CSS 被误改回 start。
    expect(ruleBody(".workspace-grid")).toMatch(/align-items:\s*stretch;/);
    expect(ruleBody(".workspace-grid")).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\);/);
    expect(ruleBody(".progress-panel")).toMatch(/min-height:\s*0;/);
    expect(ruleBody(".progress-panel")).toMatch(/overflow-y:\s*auto;/);
    expect(ruleBody(".workspace-content")).toMatch(/height:\s*100%;/);
    expect(ruleBody(".workspace-content")).toMatch(/overflow-y:\s*auto;/);
  });

  it("uses an explicit paper-feed animation for newly printed records", () => {
    expect(ruleBody('.printer-record[data-latest="true"]')).toMatch(/animation:\s*printer-feed/);
    expect(styles).toMatch(/@keyframes\s+printer-feed/);
    expect(ruleBody(".research-report > .eyebrow")).toMatch(/animation:\s*report-feed/);
    expect(ruleBody(".research-report > h2")).toMatch(/animation:\s*report-feed/);
    expect(ruleBody(".research-report > section")).toMatch(/animation:\s*report-feed/);
    expect(styles).toMatch(/@keyframes\s+report-feed/);
  });

  it("disables reveal animations when reduced motion is requested", () => {
    const reducedMotionStart = styles.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(reducedMotionStart).toBeGreaterThanOrEqual(0);
    const reducedMotionStyles = styles.slice(reducedMotionStart);

    expect(ruleBody('.printer-record[data-latest="true"]', reducedMotionStyles)).toMatch(/animation:\s*none\s*!important;/);
    expect(ruleBody('.printer-record[data-latest="true"] article::after', reducedMotionStyles)).toMatch(/animation:\s*none\s*!important;/);
    expect(ruleBody(".research-report > .eyebrow", reducedMotionStyles)).toMatch(/animation:\s*none\s*!important;/);
    expect(ruleBody(".research-report > h2", reducedMotionStyles)).toMatch(/animation:\s*none\s*!important;/);
    expect(ruleBody(".research-report > section", reducedMotionStyles)).toMatch(/animation:\s*none\s*!important;/);
  });

  it("leaves nested document regions vertically unbounded", () => {
    const printerViewport = ruleBody(".printer-viewport");
    const eventPre = ruleBody(".event-card pre");

    expect(printerViewport).not.toMatch(/max-height\s*:/);
    expect(printerViewport).toMatch(/overflow-y:\s*visible;/);
    expect(printerViewport).not.toMatch(/overscroll-behavior\s*:/);
    expect(eventPre).not.toMatch(/max-height\s*:/);
    expect(eventPre).toMatch(/overflow:\s*visible;/);
    expect(eventPre).not.toMatch(/overflow-x:\s*auto;/);
    expect(eventPre).not.toMatch(/overflow-y:\s*auto;/);
  });

  it("ignores declarations inside CSS comments", () => {
    const commentedStyles = `.example {
      /* overflow: visible; */
      color: black;
    }`;

    expect(ruleBody(".example", commentedStyles)).not.toMatch(/overflow:\s*visible;/);
  });
});
