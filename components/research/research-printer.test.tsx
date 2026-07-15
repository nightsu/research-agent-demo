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

  it("does not own scrolling or render an internal follow control", () => {
    const { rerender } = render(<ResearchPrinter records={records} onSourceSelect={vi.fn()} />);
    const viewport = screen.getByRole("region", { name: /research process/i });
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
      scrollTo: { configurable: true, value: scrollTo },
    });

    rerender(<ResearchPrinter records={[
      ...records,
      { id: "c2", kind: "conclusion", summary: "Converging" },
    ]} onSourceSelect={vi.fn()} />);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(100);
    fireEvent.scroll(viewport);
    expect(screen.queryByRole("button", { name: /back to latest progress/i })).not.toBeInTheDocument();
  });

  it("marks only the newest record as the sheet currently being printed", () => {
    const { container } = render(<ResearchPrinter records={[
      ...records,
      { id: "c2", kind: "conclusion", summary: "Converging" },
    ]} onSourceSelect={vi.fn()} />);

    const printedRecords = container.querySelectorAll(".printer-record");
    const latestRecords = container.querySelectorAll('.printer-record[data-latest="true"]');
    expect(latestRecords).toHaveLength(1);
    expect(latestRecords[0]).toBe(printedRecords[printedRecords.length - 1]);
  });
});
