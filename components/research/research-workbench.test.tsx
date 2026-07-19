import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResearchEvent } from "@/lib/agent/research-events";
import type {
  ResearchInput,
  ResearchPlan,
  ResearchReport,
  Source,
} from "@/lib/agent/research-types";

import { ResearchForm } from "./research-form";
import { ResearchProgress } from "./research-progress";
import { ResearchReportView } from "./research-report";
import { deriveResearchViewModel } from "./research-view-model";
import { ResearchWorkbench } from "./research-workbench";
import type { ReportDraftState } from "./use-research-stream";

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
const approvePlan = vi.fn();
const cancel = vi.fn();
const reset = vi.fn();
const retry = vi.fn();
let mockedRun: {
  status: "idle" | "running" | "awaiting-review" | "completed" | "partial" | "cancelled" | "failed";
  events: ResearchEvent[];
  reportDraft?: ReportDraftState;
  hadReportDraft?: boolean;
  error?: string;
};
let mockedPlanReview:
  | { input: ResearchInput; plan: ResearchPlan }
  | undefined;

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

function defineMobileDocumentScroll(scrollTop = 700) {
  vi.stubGlobal("innerWidth", 900);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    media: "(max-width: 960px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  const scrollingElement = document.documentElement;
  Object.defineProperties(scrollingElement, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
  Object.defineProperty(document, "scrollingElement", {
    configurable: true,
    value: scrollingElement,
  });
  const scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  return { scrollingElement, scrollTo };
}

function defineMutableMediaQuery(initialMatches: boolean) {
  let changeHandler: ((event: MediaQueryListEvent) => void) | undefined;
  const mediaQuery = {
    matches: initialMatches,
    media: "(max-width: 960px)",
    onchange: null,
    addEventListener: vi.fn((type: string, handler: (event: MediaQueryListEvent) => void) => {
      if (type === "change") changeHandler = handler;
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  return {
    mediaQuery,
    change(matches: boolean) {
      mediaQuery.matches = matches;
      act(() => changeHandler?.({ matches } as MediaQueryListEvent));
    },
    getChangeHandler: () => changeHandler,
  };
}

function defineDocumentScrollMetrics(scrollTop = 700) {
  const scrollingElement = document.documentElement;
  Object.defineProperties(scrollingElement, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
  Object.defineProperty(document, "scrollingElement", {
    configurable: true,
    value: scrollingElement,
  });
  const scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  return { scrollingElement, scrollTo };
}

vi.mock("./use-research-stream", () => ({
  useResearchStream: () => ({
    run: mockedRun,
    planReview: mockedPlanReview,
    start,
    approvePlan,
    cancel,
    reset,
    retry,
    canRetry: true,
  }),
}));

beforeEach(() => {
  mockedRun = { status: "idle", events: [] };
  mockedPlanReview = undefined;
  start.mockReset();
  approvePlan.mockReset();
  cancel.mockReset();
  reset.mockReset();
  retry.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it("reviews and revises every plan field while keeping the original input locked", () => {
    const reviewInput: ResearchInput = {
      question: "What changed in browser rendering this year?",
      timeRange: "year",
      depth: "quick",
    };
    const reviewPlan: ResearchPlan = {
      objective: "Identify meaningful browser rendering changes",
      subquestions: ["What shipped?"],
      searchQueries: ["browser rendering changes 2026"],
    };
    mockedRun = {
      status: "awaiting-review",
      events: [
        { type: "plan.completed", plan: reviewPlan },
        { type: "plan.awaiting_approval" },
      ],
    };
    mockedPlanReview = {
      input: reviewInput,
      plan: reviewPlan,
    };
    render(<ResearchWorkbench />);

    expect(screen.getByText(mockedPlanReview.input.question)).toBeInTheDocument();
    expect(screen.getByText(/past year/i)).toBeInTheDocument();
    expect(screen.getByText(/quick scan/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/research objective/i), {
      target: { value: "Compare rendering changes" },
    });
    fireEvent.change(screen.getByLabelText(/subquestion 1/i), {
      target: { value: "Which changes matter?" },
    });
    fireEvent.change(screen.getByLabelText(/search query 1/i), {
      target: { value: "important rendering changes 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add subquestion/i }));
    fireEvent.change(screen.getByLabelText(/subquestion 2/i), {
      target: { value: "Who is affected?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add search query/i }));
    fireEvent.change(screen.getByLabelText(/search query 2/i), {
      target: { value: "rendering change impact 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: /approve and research/i }));

    expect(approvePlan).toHaveBeenCalledWith({
      objective: "Compare rendering changes",
      subquestions: ["Which changes matter?", "Who is affected?"],
      searchQueries: [
        "important rendering changes 2026",
        "rendering change impact 2026",
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: /discard plan/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

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

  it("promotes the draft to primary content and moves the Printer into a closed archive", () => {
    mockedRun = { status: "running", events: completedEvents.slice(0, -2) };
    const { rerender } = render(<ResearchWorkbench />);
    const printer = screen.getByText("How the research unfolded").closest(".printer-shell");
    expect(printer?.closest("details")).toBeNull();

    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "", sequence: -1, status: "streaming" },
      hadReportDraft: false,
    };
    rerender(<ResearchWorkbench />);

    expect(screen.getByText("正在生成报告草稿").closest(".streaming-report-draft")).toBeInTheDocument();
    const archive = screen.getByText(/view research process/i).closest("details");
    expect(archive).not.toHaveAttribute("open");
    expect(archive).toContainElement(screen.getByText("How the research unfolded"));
  });

  it("positions the report surface at the top once, then follows draft growth at the bottom", () => {
    mockedRun = { status: "running", events: completedEvents.slice(0, -2) };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport);
    scrollTo.mockClear();

    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "", sequence: -1, status: "streaming" },
      hadReportDraft: false,
    };
    rerender(<ResearchWorkbench />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    scrollTo.mockClear();

    mockedRun = {
      status: "running",
      events: [
        ...completedEvents.slice(0, -1),
        { type: "report.delta", sequence: 0, mode: "append", text: "# Draft" },
      ],
      reportDraft: { markdown: "# Draft", sequence: 0, status: "streaming" },
      hadReportDraft: true,
    };
    rerender(<ResearchWorkbench />);
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("pauses draft following while reading and resumes at the latest report", () => {
    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "# Draft", sequence: 0, status: "streaming" },
      hadReportDraft: true,
    };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 200);
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: /back to latest report/i })).toBeInTheDocument();
    scrollTo.mockClear();

    mockedRun = {
      ...mockedRun,
      events: [
        ...mockedRun.events,
        { type: "report.delta", sequence: 1, mode: "append", text: "\nMore" },
      ],
      reportDraft: { markdown: "# Draft\nMore", sequence: 1, status: "streaming" },
    };
    rerender(<ResearchWorkbench />);
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /back to latest report/i }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
    expect(screen.queryByRole("button", { name: /back to latest report/i })).not.toBeInTheDocument();
  });

  it("keeps one draft visible through validation and repair while updating the archived synthesis", () => {
    mockedRun = {
      status: "running",
      events: [
        ...completedEvents.slice(0, -1),
        { type: "report.delta", sequence: 0, mode: "append", text: "# Draft" },
        { type: "report.validating" },
      ],
      reportDraft: { markdown: "# Draft", sequence: 0, status: "validating" },
      hadReportDraft: true,
    };
    const { rerender } = render(<ResearchWorkbench />);
    expect(screen.getAllByRole("heading", { name: "Draft" })).toHaveLength(1);
    expect(screen.getByText("Synthesis · validating")).toBeInTheDocument();

    mockedRun = {
      ...mockedRun,
      events: [...mockedRun.events, { type: "report.repairing" }],
      reportDraft: { markdown: "# Draft", sequence: 0, status: "repairing" },
    };
    rerender(<ResearchWorkbench />);
    expect(screen.getAllByRole("heading", { name: "Draft" })).toHaveLength(1);
    expect(screen.getByText("Synthesis · repairing")).toBeInTheDocument();
  });

  it.each([
    {
      status: "cancelled" as const,
      event: { type: "research.cancelled" } as ResearchEvent,
      outcome: /research · cancelled/i,
    },
    {
      status: "failed" as const,
      event: { type: "research.failed", message: "Safe failure", recoverable: true } as ResearchEvent,
      outcome: /research · failed/i,
    },
  ])("retains an incomplete draft and one terminal archive card when $status", ({ status, event, outcome }) => {
    mockedRun = {
      status,
      events: [
        ...completedEvents.slice(0, -1),
        { type: "report.delta", sequence: 0, mode: "append", text: "# Incomplete" },
        event,
      ],
      reportDraft: { markdown: "# Incomplete", sequence: 0, status: "incomplete" },
      hadReportDraft: true,
      error: status === "failed" ? "Safe failure" : undefined,
    };
    render(<ResearchWorkbench />);

    expect(screen.getByText(/报告草稿未完成/)).toBeVisible();
    expect(screen.getAllByText(outcome)).toHaveLength(1);
    expect(screen.getAllByText(/view research process/i)).toHaveLength(1);
  });

  it("replaces a streamed draft in place without moving the reader or replaying report animation", () => {
    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "# Draft", sequence: 0, status: "streaming" },
      hadReportDraft: true,
    };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const scrollTo = defineWorkspaceScroll(viewport, 200);
    fireEvent.scroll(viewport);
    scrollTo.mockClear();

    mockedRun = { status: "completed", events: completedEvents, hadReportDraft: true };
    rerender(<ResearchWorkbench />);

    expect(screen.getByRole("heading", { name: report.title }).closest(".research-report")).toHaveAttribute("data-animate", "false");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(200);
  });

  it("animates the formal report fallback when no report delta was received", () => {
    mockedRun = { status: "completed", events: completedEvents, hadReportDraft: false };
    render(<ResearchWorkbench />);

    expect(screen.getByRole("heading", { name: report.title }).closest(".research-report")).toHaveAttribute("data-animate", "true");
  });

  it("clears draft-facing UI when retrying or starting a new research", () => {
    mockedRun = {
      status: "failed",
      events: [
        ...completedEvents.slice(0, -1),
        { type: "research.failed", message: "Safe failure", recoverable: true },
      ],
      reportDraft: { markdown: "# Incomplete", sequence: 0, status: "incomplete" },
      hadReportDraft: true,
      error: "Safe failure",
    };
    const { rerender } = render(<ResearchWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: /retry research/i }));
    expect(retry).toHaveBeenCalledOnce();

    mockedRun = { status: "running", events: [], hadReportDraft: false };
    rerender(<ResearchWorkbench />);
    expect(screen.queryByText(/报告草稿未完成/)).not.toBeInTheDocument();
    expect(screen.getByText("How the research unfolded").closest("details")).toBeNull();

    mockedRun = {
      status: "cancelled",
      events: [{ type: "research.cancelled" }],
      reportDraft: { markdown: "# Incomplete", sequence: 0, status: "incomplete" },
      hadReportDraft: true,
    };
    rerender(<ResearchWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: /new research/i }));
    expect(reset).toHaveBeenCalledOnce();

    mockedRun = { status: "idle", events: [], hadReportDraft: false };
    rerender(<ResearchWorkbench />);
    expect(screen.getByRole("form", { name: /start research/i })).toBeInTheDocument();
  });

  it("uses the document scroll owner to position a newly started report on mobile", () => {
    const { scrollingElement, scrollTo: windowScrollTo } = defineMobileDocumentScroll(120);
    mockedRun = { status: "running", events: completedEvents.slice(0, -2) };
    const { rerender } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const workspaceScrollTo = defineWorkspaceScroll(viewport);
    const documentWrapper = viewport.firstElementChild as HTMLElement;
    vi.spyOn(documentWrapper, "getBoundingClientRect").mockReturnValue({
      top: 250,
      right: 0,
      bottom: 0,
      left: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 250,
      toJSON: () => ({}),
    });

    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "", sequence: -1, status: "streaming" },
      hadReportDraft: false,
    };
    rerender(<ResearchWorkbench />);

    expect(windowScrollTo).toHaveBeenCalledWith({ top: 370, behavior: "auto" });
    expect(workspaceScrollTo).not.toHaveBeenCalled();
    expect(scrollingElement.scrollTop).toBe(120);
  });

  it("pauses mobile document following and resumes at the document bottom", () => {
    const { scrollingElement, scrollTo: windowScrollTo } = defineMobileDocumentScroll(200);
    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "# Draft", sequence: 0, status: "streaming" },
      hadReportDraft: true,
    };
    const { rerender } = render(<ResearchWorkbench />);
    windowScrollTo.mockClear();

    fireEvent.scroll(window);
    expect(screen.getByRole("button", { name: /back to latest report/i })).toBeInTheDocument();

    mockedRun = {
      ...mockedRun,
      events: [...mockedRun.events, { type: "report.delta", sequence: 1, mode: "append", text: "\nMore" }],
      reportDraft: { markdown: "# Draft\nMore", sequence: 1, status: "streaming" },
    };
    rerender(<ResearchWorkbench />);
    expect(windowScrollTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /back to latest report/i }));
    expect(windowScrollTo).toHaveBeenCalledWith({
      top: scrollingElement.scrollHeight,
      behavior: "auto",
    });
    expect(screen.queryByRole("button", { name: /back to latest report/i })).not.toBeInTheDocument();
  });

  it("follows mobile draft resize at document bottom but preserves position on formal replacement", () => {
    let notifyResize: ResizeObserverCallback = () => undefined;
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const { scrollingElement, scrollTo: windowScrollTo } = defineMobileDocumentScroll(790);
    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "# Draft", sequence: 0, status: "streaming" },
      hadReportDraft: true,
    };
    const { rerender } = render(<ResearchWorkbench />);

    mockedRun = {
      ...mockedRun,
      events: [...mockedRun.events, { type: "report.delta", sequence: 1, mode: "append", text: "\nMore" }],
      reportDraft: { markdown: "# Draft\nMore", sequence: 1, status: "streaming" },
    };
    rerender(<ResearchWorkbench />);
    windowScrollTo.mockClear();
    Object.defineProperty(scrollingElement, "scrollHeight", { configurable: true, value: 1500 });
    act(() => notifyResize([], {} as ResizeObserver));
    expect(windowScrollTo).toHaveBeenCalledWith({ top: 1500, behavior: "auto" });

    windowScrollTo.mockClear();
    mockedRun = { status: "completed", events: completedEvents, hadReportDraft: true };
    rerender(<ResearchWorkbench />);
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("cleans up the mobile window scroll listener", () => {
    defineMobileDocumentScroll();
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    mockedRun = { status: "running", events: [] };
    const { unmount } = render(<ResearchWorkbench />);
    const scrollListener = addEventListener.mock.calls.find(([type]) => type === "scroll")?.[1];

    expect(scrollListener).toBeTypeOf("function");
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("scroll", scrollListener);
  });

  it("migrates a followed desktop workspace to the mobile document bottom", () => {
    const media = defineMutableMediaQuery(false);
    const { scrollingElement, scrollTo: windowScrollTo } = defineDocumentScrollMetrics();
    mockedRun = { status: "running", events: [] };
    render(<ResearchWorkbench />);

    media.change(true);

    expect(windowScrollTo).toHaveBeenCalledWith({
      top: scrollingElement.scrollHeight,
      behavior: "auto",
    });
  });

  it("migrates a followed mobile document to the desktop workspace bottom", () => {
    const media = defineMutableMediaQuery(true);
    defineDocumentScrollMetrics();
    mockedRun = { status: "running", events: [] };
    render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const workspaceScrollTo = defineWorkspaceScroll(viewport);

    media.change(false);

    expect(workspaceScrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
  });

  it("preserves a paused intent across owner changes and resumes the current owner", () => {
    const media = defineMutableMediaQuery(false);
    const { scrollingElement, scrollTo: windowScrollTo } = defineDocumentScrollMetrics(200);
    mockedRun = {
      status: "running",
      events: completedEvents.slice(0, -1),
      reportDraft: { markdown: "# Draft", sequence: 0, status: "streaming" },
      hadReportDraft: true,
    };
    render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const workspaceScrollTo = defineWorkspaceScroll(viewport, 200);
    fireEvent.scroll(viewport);
    expect(screen.getByRole("button", { name: /back to latest report/i })).toBeInTheDocument();
    workspaceScrollTo.mockClear();
    windowScrollTo.mockClear();

    media.change(true);
    media.change(false);
    media.change(true);
    expect(workspaceScrollTo).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /back to latest report/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /back to latest report/i }));
    expect(windowScrollTo).toHaveBeenCalledWith({
      top: scrollingElement.scrollHeight,
      behavior: "auto",
    });
  });

  it("removes the same media query change listener on unmount", () => {
    const media = defineMutableMediaQuery(false);
    mockedRun = { status: "running", events: [] };
    const { unmount } = render(<ResearchWorkbench />);
    const changeHandler = media.getChangeHandler();

    expect(changeHandler).toBeTypeOf("function");
    unmount();
    expect(media.mediaQuery.removeEventListener).toHaveBeenCalledWith("change", changeHandler);
  });

  it("falls back to resize-driven ownership migration without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("innerWidth", 1200);
    const { scrollingElement, scrollTo: windowScrollTo } = defineDocumentScrollMetrics();
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    mockedRun = { status: "running", events: [] };
    const { unmount } = render(<ResearchWorkbench />);
    const viewport = screen.getByRole("region", { name: /research workspace content/i });
    const workspaceScrollTo = defineWorkspaceScroll(viewport);

    vi.stubGlobal("innerWidth", 900);
    fireEvent.resize(window);
    expect(windowScrollTo).toHaveBeenCalledWith({
      top: scrollingElement.scrollHeight,
      behavior: "auto",
    });

    vi.stubGlobal("innerWidth", 1200);
    fireEvent.resize(window);
    expect(workspaceScrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });

    const resizeListener = removeEventListener.mock.calls.find(([type]) => type === "resize");
    expect(resizeListener).toBeUndefined();
    unmount();
    expect(removeEventListener.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });
});

function exampleContainingBrowser(element: HTMLElement): string {
  const value = (element as HTMLTextAreaElement).value;
  expect(value).toMatch(/browser/i);
  return value;
}
