# Research Operation Timeout Design

## Goal

Prevent otherwise valid Kimi planning requests from failing solely because the current 30-second per-operation deadline is too short.

## Design

Increase `defaultResearchLimits.requestTimeoutMs` from `30_000` to `120_000`, the existing schema maximum. Because `quickResearchLimits` inherits from `defaultResearchLimits`, both quick and deep research modes will use the new deadline without duplicating configuration.

Keep the route-level `maxDuration` at 300 seconds. The operation deadline remains shorter than the overall route lifetime and continues to apply independently to model calls, Tavily calls, and event delivery.

Do not introduce an environment variable in this change. A single documented default is sufficient for the current live-provider diagnosis and avoids adding an unvalidated runtime configuration path.

## Tests and Documentation

- Add or update a limits test that asserts the default timeout is 120 seconds and remains accepted by `researchLimitsSchema`.
- Run the focused test first, then the complete test suite and TypeScript typecheck.
- Update README text that currently describes a 30-second per-operation timeout.

## Success Criteria

- Quick and deep research operations receive a 120-second deadline.
- Existing timeout behavior and public failure mapping remain unchanged.
- Tests and typechecking pass.
- Documentation reports the new 120-second limit.
