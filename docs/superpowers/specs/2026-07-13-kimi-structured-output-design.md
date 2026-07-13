# Kimi Structured Output Design

## Goal

Make `kimi-k2.6` planning and research generations use Kimi's native JSON Schema structured output so valid provider responses do not unnecessarily enter the repair path and consume the shared operation deadline.

## Root Cause

The research model uses AI SDK `Output.object` with Zod schemas, but the Kimi OpenAI-compatible provider does not declare `supportsStructuredOutputs`. The adapter therefore warns that schema-backed `responseFormat` is unsupported and falls back to `json_object`. JSON mode guarantees valid JSON but does not enforce the application schema, so a schema mismatch can trigger a second repair generation. Both generations currently run inside one research operation deadline.

Kimi's Chat Completions API documents `response_format: { "type": "json_schema" }` for Structured Output, including a `json_schema` payload. The provider can therefore advertise this capability to the AI SDK.

## Scope

- Set `supportsStructuredOutputs: true` only on the Kimi `createOpenAICompatible` configuration.
- Keep the DeepSeek configuration unchanged until it is independently verified.
- Keep the 120-second per-operation timeout and the existing one-repair policy unchanged.
- Keep the research workflow, event protocol, prompts, and Zod schemas unchanged.

## Data Flow

1. `getResearchModel()` creates the Kimi OpenAI-compatible provider with structured output support enabled.
2. `generateText` receives `Output.object({ schema })` as it does today.
3. The adapter serializes the schema as Kimi's `response_format.type = json_schema` request instead of falling back to `json_object`.
4. Kimi constrains the response to the requested schema.
5. The application still performs its final Zod parse and retains one repair attempt for genuinely malformed or incompatible output.

## Error Handling

Provider, authentication, rate-limit, cancellation, and timeout failures remain single-call failures. Only structured-output generation or validation failures may use the existing repair attempt. Public research failure events remain unchanged.

## Testing and Verification

- Add a provider unit test asserting that the Kimi provider is created with `supportsStructuredOutputs: true`.
- Assert that DeepSeek does not receive the flag.
- Run the full unit test suite, typecheck, lint, and production build.
- Inspect the production server output to confirm the previous `responseFormat` warning no longer appears during a live Kimi planning request.
- Run one live quick-depth research smoke test and confirm planning advances beyond the initial model operation without an avoidable repair request.

## Non-Goals

- Enabling or validating DeepSeek structured output.
- Increasing operation or route timeouts.
- Removing the repair path.
- Replacing AI SDK structured generation with tool calls or custom JSON parsing.
