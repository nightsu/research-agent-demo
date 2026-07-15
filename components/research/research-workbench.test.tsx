import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type { ResearchReport, Source } from "@/lib/agent/research-types";

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
  { type: "progress.updated", operationCount: 7, operationLimit: 12, searchRounds: 2, searchRoundLimit: 3 },
  { type: "report.started", partial: false },
  { type: "report.completed", report },
];

const start = vi.fn();
const cancel = vi.fn();
const reset = vi.fn();
const retry = vi.fn();
let mockedRun: {
  status: "idle" | "running" | "completed" | "partial" | "cancelled" | "failed";
  events: ResearchEvent[];
  error?: string;
};

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

vi.mock("./use-research-stream", () => ({
  useResearchStream: () => ({ run: mockedRun, start, cancel, reset, retry, canRetry: true }),
}));

beforeEach(() => {
  mockedRun = { status: "idle", events: [] };
  start.mockReset();
  cancel.mockReset();
  reset.mockReset();
  retry.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
        viewModel={deriveResearchViewModel(completedEvents)}
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
    expect(screen.getByText("Search rounds 2/3")).toBeInTheDocument();
    expect(screen.getByText("Agent operations 7/12")).toBeInTheDocument();
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
        viewModel={deriveResearchViewModel(loopEvents)}
        status="running"
      />,
    );

    expect(screen.getByText("Searching").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it.each([
    {
      status: "cancelled" as const,
      events: [
        ...completedEvents.slice(0, 3),
        { type: "research.cancelled" } as ResearchEvent,
      ],
      phase: "Searching",
      outcome: "Cancelled",
    },
    {
      status: "failed" as const,
      events: [
        ...completedEvents.slice(0, 6),
        {
          type: "research.failed",
          message: "Research failed safely.",
          recoverable: true,
        } as ResearchEvent,
      ],
      phase: "Evaluating",
      outcome: "Failed",
    },
  ])("shows the $status outcome on the interrupted $phase phase", ({ status, events, phase, outcome }) => {
    render(
      <ResearchProgress
        viewModel={deriveResearchViewModel(events)}
        status={status}
      />,
    );

    const interrupted = screen.getByText(phase).closest("li");
    expect(interrupted).toHaveTextContent(outcome);
    expect(interrupted).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Planning").closest("li")).toHaveTextContent("Completed");
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

  it("only makes collected source URLs clickable in model markdown", () => {
    const linkedReport: ResearchReport = {
      ...report,
      executiveSummary: [
        `[Known source](${source.url}#details)`,
        "[Unknown source](https://attacker.example/phish)",
        "[Script](javascript:alert(1))",
      ].join(" "),
    };
    render(
      <ResearchReportView
        report={linkedReport}
        sources={[source]}
        onCitation={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: /known source.*new tab/i })).toHaveAttribute(
      "href",
      source.url,
    );
    expect(screen.queryByRole("link", { name: /unknown source/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /script/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/link unavailable: not a collected source/i)).toHaveLength(2);
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
    const timeline = screen.getByRole("region", { name: /research process/i });
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

  it("promotes a partial report, collapses the process, and opens cited evidence", () => {
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
    const drawer = screen.getByRole("dialog", { name: source.title });
    expect(within(drawer).getByRole("link", { name: /open original source/i })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(within(drawer).getByRole("link", { name: /open original source/i })).toHaveAttribute(
      "rel",
      expect.stringContaining("noreferrer"),
    );
    expect(screen.getByText(/view research process/i).closest("details")).not.toHaveAttribute("open");

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

  it("keeps a failed process visible and retries from scratch", () => {
    mockedRun = { status: "failed", events: completedEvents.slice(0, 5), error: "Research stream failed." };
    render(<ResearchWorkbench />);
    expect(screen.getByRole("region", { name: /research process/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry research/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("pauses workspace following while the reader reviews earlier records", () => {
    mockedRun = { status: "running", events: completedEvents.slice(0, 4) };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 200);
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: /back to latest progress/i })).toBeInTheDocument();
    scrollTo.mockClear();

    mockedRun = {
      status: "running",
      events: [
        ...completedEvents.slice(0, 4),
        { type: "conclusion.updated", summary: "New evidence" },
      ],
    };
    rerender(<ResearchWorkbench />);
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /back to latest progress/i }));
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("follows new records when the workspace remains near the bottom", () => {
    mockedRun = { status: "running", events: completedEvents.slice(0, 4) };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 690);
    fireEvent.scroll(viewport);
    scrollTo.mockClear();

    mockedRun = {
      status: "running",
      events: [
        ...completedEvents.slice(0, 4),
        { type: "conclusion.updated", summary: "New evidence" },
      ],
    };
    rerender(<ResearchWorkbench />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("follows event growth when the latest printer record is updated in place", () => {
    mockedRun = { status: "running", events: completedEvents.slice(0, 3) };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 690);
    expect(screen.getByText("2 records")).toBeInTheDocument();
    fireEvent.scroll(viewport);
    scrollTo.mockClear();

    mockedRun = { status: "running", events: completedEvents.slice(0, 4) };
    rerender(<ResearchWorkbench />);
    expect(screen.getByText("2 records")).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it.each([
    {
      status: "cancelled" as const,
      terminalEvent: { type: "research.cancelled" } as ResearchEvent,
    },
    {
      status: "failed" as const,
      terminalEvent: {
        type: "research.failed",
        message: "Research failed safely.",
        recoverable: true,
      } as ResearchEvent,
    },
  ])("follows the terminal record when research becomes $status", ({ status, terminalEvent }) => {
    const runningEvents = completedEvents.slice(0, 4);
    mockedRun = { status: "running", events: runningEvents };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 690);
    fireEvent.scroll(viewport);
    scrollTo.mockClear();

    mockedRun = { status, events: [...runningEvents, terminalEvent] };
    rerender(<ResearchWorkbench />);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("recalculates following when expanded content changes the document height", () => {
    let notifyResize: ResizeObserverCallback = () => undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    mockedRun = { status: "running", events: completedEvents.slice(0, 4) };
    const { rerender, unmount } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 690);
    fireEvent.scroll(viewport);

    const planDetails = screen.getByText("Plan details").closest("details");
    expect(planDetails).not.toBeNull();
    fireEvent.click(within(planDetails!).getByText("Plan details"));
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1200 });
    act(() => notifyResize([], {} as ResizeObserver));
    expect(screen.getByRole("button", { name: /back to latest progress/i })).toBeInTheDocument();

    scrollTo.mockClear();
    mockedRun = {
      status: "running",
      events: [
        ...completedEvents.slice(0, 4),
        { type: "conclusion.updated", summary: "New evidence" },
      ],
    };
    rerender(<ResearchWorkbench />);
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(within(planDetails!).getByText("Plan details"));
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
    act(() => notifyResize([], {} as ResizeObserver));
    expect(screen.queryByRole("button", { name: /back to latest progress/i })).not.toBeInTheDocument();

    expect(observe).toHaveBeenCalledOnce();
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
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
    scrollTo.mockClear();

    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /back to latest progress/i })).not.toBeInTheDocument();
  });
});

function exampleContainingBrowser(element: HTMLElement): string {
  const value = (element as HTMLTextAreaElement).value;
  expect(value).toMatch(/browser/i);
  return value;
}
