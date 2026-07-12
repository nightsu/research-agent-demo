import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchReport, Source } from "@/lib/agent/research-types";

import { EventTimeline } from "./event-timeline";
import { ResearchForm } from "./research-form";
import { ResearchProgress } from "./research-progress";
import { ResearchReportView } from "./research-report";
import { deriveResearchViewModel } from "./research-view-model";
import { ResearchWorkbench } from "./research-workbench";

const source: Source = {
  id: "source-1",
  title: "A useful source",
  url: "https://example.com/research",
  domain: "example.com",
  snippet: "A concise excerpt from the source.",
  rawContent: "private full content that should stay collapsed",
  publishedAt: "2026-06-02",
};

const report: ResearchReport = {
  title: "Browser research",
  executiveSummary: "The **evidence** points to a measurable change.",
  findings: [
    {
      claim: "The platform changed in 2026.",
      sourceIds: ["source-1", "missing-source"],
      confidence: "high",
    },
  ],
  trends: ["Adoption is increasing."],
  disagreements: ["Sources disagree on timing."],
  limitations: ["Only public evidence was reviewed."],
};

const completedEvents: ResearchEvent[] = [
  { type: "plan.started", question: "What changed in browser rendering?" },
  {
    type: "plan.completed",
    plan: {
      objective: "Identify meaningful browser rendering changes",
      subquestions: ["What shipped?", "What is the impact?"],
      searchQueries: ["browser rendering changes 2026"],
    },
  },
  {
    type: "search.started",
    query: "browser rendering changes 2026",
    reason: "Find current primary evidence",
  },
  {
    type: "search.completed",
    query: "browser rendering changes 2026",
    sources: [source],
    resultCount: 1,
  },
  { type: "source.read", sourceId: source.id, url: source.url },
  {
    type: "source.evaluated",
    evaluation: {
      sourceId: source.id,
      decision: "accepted",
      relevance: 5,
      authority: 4,
      freshness: 5,
      reason: "Direct and current evidence",
    },
  },
  {
    type: "gap.detected",
    description: "Independent confirmation is limited",
    followUpQueries: ["browser rendering independent analysis"],
  },
  { type: "conclusion.updated", summary: "Evidence is converging." },
  { type: "report.started", partial: false },
  { type: "report.completed", report },
];

const start = vi.fn();
const cancel = vi.fn();
const reset = vi.fn();
let mockedRun: {
  status: "idle" | "running" | "completed" | "partial" | "cancelled" | "failed";
  events: ResearchEvent[];
  error?: string;
};

vi.mock("./use-research-stream", () => ({
  useResearchStream: () => ({ run: mockedRun, start, cancel, reset }),
}));

beforeEach(() => {
  mockedRun = { status: "idle", events: [] };
  start.mockReset();
  cancel.mockReset();
  reset.mockReset();
});

afterEach(cleanup);

describe("ResearchForm", () => {
  it("fills an example and submits a valid accessible request", () => {
    const onSubmit = vi.fn();
    render(<ResearchForm disabled={false} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /try example/i }));
    const question = screen.getByLabelText(/research question/i);
    expect(question).toHaveValue(exampleContainingBrowser(question));
    fireEvent.change(screen.getByLabelText(/time range/i), {
      target: { value: "month" },
    });
    fireEvent.change(screen.getByLabelText(/research depth/i), {
      target: { value: "deep" },
    });
    fireEvent.submit(screen.getByRole("form", { name: /start research/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      question: expect.stringMatching(/browser/i),
      timeRange: "month",
      depth: "deep",
    });
  });

  it("announces validation and disables all controls while loading", () => {
    const { rerender } = render(
      <ResearchForm disabled={false} onSubmit={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText(/research question/i), {
      target: { value: "too short" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start research/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least 10/i);
    expect(screen.getByLabelText(/research question/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    rerender(<ResearchForm disabled onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /researching/i })).toBeDisabled();
    expect(screen.getByLabelText(/research question/i)).toBeDisabled();
    expect(screen.getByLabelText(/time range/i)).toBeDisabled();
  });
});

describe("observable research views", () => {
  it("shows plan phases, counters, and status text without relying on color", () => {
    render(
      <ResearchProgress
        viewModel={deriveResearchViewModel(completedEvents, "running")}
        status="running"
      />,
    );
    expect(screen.getByText("Research running")).toBeInTheDocument();
    expect(screen.getByText("Planning")).toBeInTheDocument();
    expect(screen.getByText("Searching")).toBeInTheDocument();
    expect(screen.getByText("Evaluating")).toBeInTheDocument();
    expect(screen.getByText("Synthesizing")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "1 accepted")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "0 rejected")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "1 source")).toBeInTheDocument();
  });

  it("marks searching current when a follow-up search starts after evaluation", () => {
    const loopEvents: ResearchEvent[] = [
      ...completedEvents.slice(0, 6),
      {
        type: "gap.detected",
        description: "Need independent confirmation",
        followUpQueries: ["follow-up evidence"],
      },
      {
        type: "search.started",
        query: "follow-up evidence",
        reason: "Close the evidence gap",
      },
    ];
    render(
      <ResearchProgress
        viewModel={deriveResearchViewModel(loopEvents, "running")}
        status="running"
      />,
    );

    expect(screen.getByText("Searching").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("renders chronological event details and keeps safe raw JSON closed", () => {
    const unsafe = {
      ...completedEvents[2],
      reasoning_content: "hidden chain claim",
    } as unknown as ResearchEvent;
    render(<EventTimeline events={[...completedEvents.slice(0, 8), unsafe]} />);

    expect(screen.getAllByText(/Identify meaningful browser/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Find current primary evidence/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/browser rendering changes 2026/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Direct and current evidence/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Independent confirmation/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Evidence is converging/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/hidden chain claim/i)).not.toBeInTheDocument();
    for (const details of screen.getAllByText(/raw event/i)) {
      expect(details.closest("details")).not.toHaveAttribute("open");
    }
  });

  it("renders a structured markdown report with only known citation buttons", () => {
    const onCitation = vi.fn();
    render(
      <ResearchReportView
        report={report}
        sources={[source]}
        onCitation={onCitation}
      />,
    );

    expect(screen.getByRole("heading", { name: report.title })).toBeInTheDocument();
    expect(screen.getByText("evidence").tagName).toBe("STRONG");
    fireEvent.click(screen.getByRole("button", { name: /source 1/i }));
    expect(onCitation).toHaveBeenCalledWith("source-1");
    expect(screen.queryByRole("button", { name: /missing/i })).not.toBeInTheDocument();
    expect(screen.getByText(/citation unavailable/i)).toBeInTheDocument();
  });
});

describe("ResearchWorkbench", () => {
  it("starts from the form and exposes a stop action while running", () => {
    const { rerender } = render(<ResearchWorkbench />);
    fireEvent.change(screen.getByLabelText(/research question/i), {
      target: { value: "What changed in browser rendering this year?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start research/i }));
    expect(start).toHaveBeenCalledWith({
      question: "What changed in browser rendering this year?",
      timeRange: "year",
      depth: "quick",
    });

    mockedRun = { status: "running", events: completedEvents.slice(0, 5) };
    rerender(<ResearchWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: /stop research/i }));
    expect(cancel).toHaveBeenCalledOnce();
    const timeline = screen.getByRole("region", { name: /research timeline/i });
    expect(timeline).not.toHaveAttribute("aria-live");
    expect(timeline).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
    expect(screen.getByRole("status")).toHaveTextContent(/research running.*source read/i);
  });

  it("keeps prior events on failure and supports a new research reset", () => {
    mockedRun = {
      status: "failed",
      events: completedEvents.slice(0, 5),
      error: "Research stream failed.",
    };
    render(<ResearchWorkbench />);
    expect(screen.getByRole("alert")).toHaveTextContent("Research stream failed.");
    expect(screen.getAllByText(/Find current primary evidence/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /new research/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("shows partial and cancelled labels and selects a cited source", () => {
    mockedRun = {
      status: "partial",
      events: [
        ...completedEvents.slice(0, -1),
        { type: "research.partial", report, reason: "Time limit reached" },
      ],
    };
    const { rerender } = render(<ResearchWorkbench />);
    expect(screen.getAllByText(/partial/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /source 1/i }));
    const sourceCard = screen.getByRole("article", { name: source.title });
    expect(sourceCard).toHaveAttribute("data-selected", "true");
    expect(within(sourceCard).getByRole("link", { name: /open source/i })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(within(sourceCard).getByRole("link", { name: /open source/i })).toHaveAttribute(
      "rel",
      expect.stringContaining("noreferrer"),
    );

    mockedRun = { status: "cancelled", events: [{ type: "research.cancelled" }] };
    rerender(<ResearchWorkbench />);
    expect(screen.getAllByText(/cancelled/i).length).toBeGreaterThan(0);
  });

  it("focuses and announces the status after a running research is cancelled", () => {
    mockedRun = { status: "running", events: completedEvents.slice(0, 5) };
    const { rerender } = render(<ResearchWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: /stop research/i }));

    mockedRun = { status: "cancelled", events: [{ type: "research.cancelled" }] };
    rerender(<ResearchWorkbench />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/research cancelled/i);
    expect(status).toHaveFocus();
  });

  it("focuses and scrolls the cited source on every citation click", () => {
    mockedRun = { status: "completed", events: completedEvents };
    render(<ResearchWorkbench />);
    const sourceCard = screen.getByRole("article", { name: source.title });
    const scrollIntoView = vi.fn();
    const focus = vi.spyOn(sourceCard as HTMLElement, "focus");
    Object.defineProperty(sourceCard, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const citation = screen.getByRole("button", { name: /source 1/i });

    fireEvent.click(citation);
    fireEvent.click(citation);

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);
  });
});

function exampleContainingBrowser(element: HTMLElement): string {
  const value = (element as HTMLTextAreaElement).value;
  expect(value).toMatch(/browser/i);
  return value;
}
