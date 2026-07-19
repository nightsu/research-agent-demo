# Centralize the Research Stream Protocol

Research stream validity will be interpreted by one deep, wire-compatible module instead of separate terminal, NDJSON, and report-delta rules in the server and browser. The module will expose an intentionally asymmetric interface—a high-leverage client consumer and a transactional server writer—because readers consume arbitrary byte chunks while writers must commit protocol state only after successful delivery; we rejected a single role-switched session and an extensible phase descriptor because they made the current interface less honest or introduced speculative generality.

## Consequences

The module owns Request Terminal and Research Terminal classification, UTF-8/NDJSON completeness, event validation, report-delta sequencing, local cancellation, and fail-closed Plan Review. Fetch generations, React batching, server backpressure, error policy, and UI projections remain in their existing adapters, and the wire format does not change.
