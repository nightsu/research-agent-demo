import type { ResearchEvent } from "@/lib/agent/research-events";

export interface EventTimelineProps {
  events: ResearchEvent[];
}

const privateKey = /reasoning|chain.?of.?thought|hidden/i;

function safeEventJson(event: ResearchEvent): string {
  return JSON.stringify(
    event,
    (key, value) => (privateKey.test(key) || key === "rawContent" ? undefined : value),
    2,
  );
}

function eventPresentation(event: ResearchEvent): {
  label: string;
  title: string;
  detail?: string;
  meta?: string;
} {
  switch (event.type) {
    case "plan.started":
      return { label: "Planning · Running", title: "Research started", detail: event.question };
    case "plan.completed":
      return {
        label: "Planning · Completed",
        title: event.plan.objective,
        detail: event.plan.subquestions.join(" · "),
        meta: `${event.plan.searchQueries.length} planned queries`,
      };
    case "search.started":
      return { label: "Search · Running", title: event.query, detail: event.reason };
    case "search.completed":
      return {
        label: "Search · Completed",
        title: event.query,
        detail: `${event.sources.length} sources retained from ${event.resultCount} results`,
      };
    case "source.read":
      return { label: "Source · Read", title: event.sourceId, detail: event.url };
    case "source.evaluated":
      return {
        label: `Source · ${event.evaluation.decision === "accepted" ? "Accepted" : "Rejected"}`,
        title: event.evaluation.sourceId,
        detail: event.evaluation.reason,
        meta: `Relevance ${event.evaluation.relevance}/5 · Authority ${event.evaluation.authority}/5 · Freshness ${event.evaluation.freshness}/5`,
      };
    case "gap.detected":
      return {
        label: "Evidence gap · Detected",
        title: event.description,
        detail: event.followUpQueries.join(" · "),
      };
    case "conclusion.updated":
      return { label: "Conclusion · Updated", title: event.summary };
    case "report.started":
      return {
        label: `Synthesis · ${event.partial ? "Partial" : "Running"}`,
        title: event.partial ? "Drafting a partial report" : "Drafting the report",
      };
    case "report.completed":
      return { label: "Synthesis · Completed", title: event.report.title };
    case "research.partial":
      return { label: "Research · Partial", title: event.report.title, detail: event.reason };
    case "research.cancelled":
      return { label: "Research · Cancelled", title: "Research stopped" };
    case "research.failed":
      return {
        label: "Research · Failed",
        title: "The run could not be completed",
        detail: event.message,
        meta: event.recoverable ? "You can try again." : "Review the request before retrying.",
      };
  }
}

export function EventTimeline({ events }: EventTimelineProps) {
  if (events.length === 0) {
    return <p className="empty-note">Events will appear here as the research agent works.</p>;
  }

  return (
    <ol className="event-list">
      {events.map((event, index) => {
        const view = eventPresentation(event);
        return (
          <li className="event-item" key={`${event.type}-${index}`}>
            <span className="timeline-dot" aria-hidden="true" />
            <article className="event-card">
              <p className="event-label">{view.label}</p>
              <h3>{view.title}</h3>
              {view.detail ? <p>{view.detail}</p> : null}
              {view.meta ? <p className="event-meta">{view.meta}</p> : null}
              <details>
                <summary>Raw event</summary>
                <pre>{safeEventJson(event)}</pre>
              </details>
            </article>
          </li>
        );
      })}
    </ol>
  );
}
