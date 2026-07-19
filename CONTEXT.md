# Observable Research

This context describes the shared language for a research run in which an agent proposes how to investigate a question and a person controls whether research may proceed.

## Language

**Research Plan**:
The agent's proposed scope and search approach for answering a research question.
_Avoid_: Task list, hidden reasoning

**Plan Review**:
The required human checkpoint after a Research Plan is proposed and before any external research begins.
_Avoid_: Optional preview, automatic approval

**Plan Revision**:
A human-authored change to the objective, subquestions, or search queries of a proposed Research Plan during Plan Review.
_Avoid_: Search-query-only edit, prompt rewrite

**Approved Plan**:
A Research Plan that has passed Plan Review and authorizes external research; retries retain that authorization until the user starts over.
_Avoid_: Draft plan, one-attempt approval
