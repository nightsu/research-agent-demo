import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Source, SourceEvaluation } from "@/lib/agent/research-types";

import { SourceDrawer } from "./source-drawer";

const source: Source = { id: "s1", title: "Primary evidence", url: "https://example.com/evidence", domain: "example.com", snippet: "Useful evidence", publishedAt: "2026-07-01" };
const evaluation: SourceEvaluation = { sourceId: "s1", decision: "accepted", relevance: 5, authority: 4, freshness: 5, reason: "Direct evidence" };

afterEach(() => { cleanup(); document.body.innerHTML = ""; });

describe("SourceDrawer", () => {
  it("shows evidence without exposing raw content", () => {
    render(<SourceDrawer source={{ ...source, rawContent: "private long body" }} evaluation={evaluation} citationNumber={1} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: source.title })).toBeInTheDocument();
    expect(screen.getByText(/relevance 5\/5/i)).toBeInTheDocument();
    expect(screen.queryByText(/private long body/i)).not.toBeInTheDocument();
  });

  it("moves focus into the drawer and restores the trigger after Escape closes it", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { rerender } = render(<SourceDrawer source={source} evaluation={evaluation} citationNumber={1} onClose={onClose} />);
    expect(screen.getByRole("button", { name: /close source details/i })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<SourceDrawer onClose={onClose} />);
    expect(trigger).toHaveFocus();
  });
});
