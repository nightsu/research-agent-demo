"use client";

import { useState, type FormEvent } from "react";

import {
  researchPlanSchema,
  type ResearchInput,
  type ResearchPlan,
} from "@/lib/agent/research-types";

interface ResearchPlanReviewProps {
  input: ResearchInput;
  plan: ResearchPlan;
  onApprove(plan: ResearchPlan): void | Promise<void>;
  onDiscard(): void;
}

const timeRangeLabels: Record<ResearchInput["timeRange"], string> = {
  week: "Past week",
  month: "Past month",
  year: "Past year",
  all: "All time",
};

const depthLabels: Record<ResearchInput["depth"], string> = {
  quick: "Quick scan",
  deep: "Deep research",
};

export function ResearchPlanReview({
  input,
  plan,
  onApprove,
  onDiscard,
}: ResearchPlanReviewProps) {
  const [draft, setDraft] = useState(plan);
  const [error, setError] = useState("");

  function updateList(
    field: "subquestions" | "searchQueries",
    index: number,
    value: string,
  ) {
    setDraft((current) => ({
      ...current,
      [field]: current[field].map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    }));
  }

  function appendListItem(field: "subquestions" | "searchQueries") {
    setDraft((current) => ({
      ...current,
      [field]: [...current[field], ""],
    }));
  }

  function removeListItem(
    field: "subquestions" | "searchQueries",
    index: number,
  ) {
    setDraft((current) => ({
      ...current,
      [field]: current[field].filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = researchPlanSchema.safeParse(draft);
    if (!parsed.success) {
      setError("Keep an objective and at least one non-empty subquestion and search query.");
      return;
    }
    setError("");
    void onApprove(parsed.data);
  }

  return (
    <main className="research-shell plan-review-shell">
      <header className="hero plan-review-hero">
        <p className="eyebrow">Plan Review</p>
        <h1>Approve the approach before research begins.</h1>
        <p>The agent has proposed a plan. Revise its scope or searches, then authorize external research.</p>
      </header>

      <section className="plan-review-brief" aria-labelledby="review-brief-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Locked research brief</p>
            <h2 id="review-brief-title">Original request</h2>
          </div>
        </div>
        <dl className="plan-review-metadata">
          <div><dt>Question</dt><dd>{input.question}</dd></div>
          <div><dt>Time range</dt><dd>{timeRangeLabels[input.timeRange]}</dd></div>
          <div><dt>Depth</dt><dd>{depthLabels[input.depth]}</dd></div>
        </dl>
      </section>

      <form className="research-form plan-review-form" aria-label="Review research plan" onSubmit={submit} noValidate>
        <div className="form-heading">
          <div>
            <p className="eyebrow">Editable plan</p>
            <h2>What should the agent investigate?</h2>
          </div>
        </div>

        <label className="field-label" htmlFor="research-objective">Research objective</label>
        <textarea
          id="research-objective"
          value={draft.objective}
          onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))}
        />

        <fieldset className="plan-review-list">
          <legend>Subquestions</legend>
          {draft.subquestions.map((subquestion, index) => (
            <div className="plan-review-list-item" key={index}>
              <label>
                <span className="field-label">Subquestion {index + 1}</span>
                <textarea
                  rows={2}
                  value={subquestion}
                  onChange={(event) => updateList("subquestions", index, event.target.value)}
                />
              </label>
              {draft.subquestions.length > 1 ? (
                <button className="text-button" type="button" onClick={() => removeListItem("subquestions", index)}>
                  Remove subquestion {index + 1}
                </button>
              ) : null}
            </div>
          ))}
          <button
            className="secondary-button"
            type="button"
            disabled={draft.subquestions.length >= 6}
            onClick={() => appendListItem("subquestions")}
          >
            Add subquestion
          </button>
        </fieldset>

        <fieldset className="plan-review-list">
          <legend>Search queries</legend>
          {draft.searchQueries.map((query, index) => (
            <div className="plan-review-list-item" key={index}>
              <label>
                <span className="field-label">Search query {index + 1}</span>
                <textarea
                  rows={2}
                  value={query}
                  onChange={(event) => updateList("searchQueries", index, event.target.value)}
                />
              </label>
              {draft.searchQueries.length > 1 ? (
                <button className="text-button" type="button" onClick={() => removeListItem("searchQueries", index)}>
                  Remove search query {index + 1}
                </button>
              ) : null}
            </div>
          ))}
          <button
            className="secondary-button"
            type="button"
            disabled={draft.searchQueries.length >= 6}
            onClick={() => appendListItem("searchQueries")}
          >
            Add search query
          </button>
        </fieldset>

        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="plan-review-actions">
          <button className="primary-button" type="submit">Approve and research</button>
          <button className="secondary-button" type="button" onClick={onDiscard}>Discard plan</button>
        </div>
      </form>
    </main>
  );
}
