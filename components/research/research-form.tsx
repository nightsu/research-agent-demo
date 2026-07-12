"use client";

import { useState, type FormEvent } from "react";

import type { ResearchRequest } from "@/lib/agent/research-types";

const exampleQuestion =
  "What changed in browser rendering performance during the past year?";

export interface ResearchFormProps {
  disabled: boolean;
  onSubmit(request: ResearchRequest): void;
}

export function ResearchForm({ disabled, onSubmit }: ResearchFormProps) {
  const [question, setQuestion] = useState("");
  const [timeRange, setTimeRange] = useState<ResearchRequest["timeRange"]>("year");
  const [depth, setDepth] = useState<ResearchRequest["depth"]>("quick");
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 10) {
      setError("Enter a research question with at least 10 characters.");
      return;
    }
    setError("");
    onSubmit({ question: trimmed, timeRange, depth });
  }

  return (
    <form className="research-form" aria-label="Start research" onSubmit={submit} noValidate>
      <div className="form-heading">
        <div>
          <p className="eyebrow">Research brief</p>
          <h2>What do you want to understand?</h2>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={disabled}
          onClick={() => {
            setQuestion(exampleQuestion);
            setError("");
          }}
        >
          Try example
        </button>
      </div>

      <label className="field-label" htmlFor="research-question">
        Research question
      </label>
      <textarea
        id="research-question"
        name="question"
        rows={4}
        value={question}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? "question-error" : "question-help"}
        placeholder="Ask a focused question with enough context to investigate…"
        onChange={(event) => {
          setQuestion(event.target.value);
          if (error) setError("");
        }}
      />
      {error ? (
        <p id="question-error" className="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p id="question-help" className="field-help">
          A specific question produces a clearer plan and better source decisions.
        </p>
      )}

      <div className="form-options">
        <label>
          <span className="field-label">Time range</span>
          <select
            value={timeRange}
            disabled={disabled}
            onChange={(event) =>
              setTimeRange(event.target.value as ResearchRequest["timeRange"])
            }
          >
            <option value="week">Past week</option>
            <option value="month">Past month</option>
            <option value="year">Past year</option>
            <option value="all">All time</option>
          </select>
        </label>
        <label>
          <span className="field-label">Research depth</span>
          <select
            value={depth}
            disabled={disabled}
            onChange={(event) =>
              setDepth(event.target.value as ResearchRequest["depth"])
            }
          >
            <option value="quick">Quick scan</option>
            <option value="deep">Deep research</option>
          </select>
        </label>
      </div>

      <button className="primary-button" type="submit" disabled={disabled}>
        {disabled ? "Researching…" : "Start research"}
      </button>
    </form>
  );
}
