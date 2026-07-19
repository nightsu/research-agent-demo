# Separate Plan Review from Research Execution

A research run first produces a Research Plan and ends its request; only a second request carrying an Approved Plan may begin external research. We chose this boundary instead of holding an NDJSON stream open during human review because human response time conflicts with browser disconnects, proxy timeouts, and serverless lifecycles, while a separate request makes authorization explicit and testable.

## Consequences

The first version keeps a proposed plan only in the current browser state, so refreshing discards it. An Approved Plan is reused when a failed or cancelled execution is retried. A future durable checkpoint store may preserve plans across refreshes or process restarts without changing the two-request boundary.
