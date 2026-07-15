import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrinterRecord } from "./research-printer-model";
import { ResearchPrinter } from "./research-printer";

const records: PrinterRecord[] = [
  {
    id: "search-1",
    kind: "search",
    query: "browser changes",
    reason: "Find primary evidence",
    status: "complete",
    resultCount: 4,
    sources: [{
      read: true,
      source: { id: "s1", title: "Primary evidence", url: "https://example.com", domain: "example.com", snippet: "Evidence" },
      evaluation: { sourceId: "s1", decision: "accepted", relevance: 5, authority: 4, freshness: 5, reason: "Direct" },
    }],
  },
];

afterEach(cleanup);

describe("ResearchPrinter", () => {
  it("renders one structured search batch and selects its source", () => {
    const onSourceSelect = vi.fn();
    render(<ResearchPrinter records={records} onSourceSelect={onSourceSelect} />);
    expect(screen.getByRole("heading", { name: /how the research unfolded/i })).toBeInTheDocument();
    expect(screen.getByText("4 results · 1 retained")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /primary evidence/i }));
    expect(onSourceSelect).toHaveBeenCalledWith("s1");
  });

  it("pauses following when the reader leaves the bottom and resumes on request", () => {
    const { rerender } = render(<ResearchPrinter records={records} onSourceSelect={vi.fn()} />);
    const viewport = screen.getByRole("region", { name: /research process/i });
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 200 },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: /back to latest progress/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /back to latest progress/i }));
    expect(screen.queryByRole("button", { name: /back to latest progress/i })).not.toBeInTheDocument();
    rerender(<ResearchPrinter records={[...records, { id: "c2", kind: "conclusion", summary: "Converging" }]} onSourceSelect={vi.fn()} />);
    expect(viewport.scrollTo).toHaveBeenCalled();
  });
});
