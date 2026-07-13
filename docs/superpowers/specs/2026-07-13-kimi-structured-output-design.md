# Kimi Structured Output Design

## Goal

Make `kimi-k2.6` planning and research generations use Kimi's native JSON Schema structured output so valid provider responses do not unnecessarily enter the repair path and consume the shared operation deadline.

## Root Cause

The research model uses AI SDK `Output.object` with Zod schemas, but the Kimi OpenAI-compatible provider does not declare `supportsStructuredOutputs`. The adapter therefore warns that schema-backed `responseFormat` is unsupported and falls back to `json_object`. JSON mode guarantees valid JSON but does not enforce the application schema, so a schema mismatch can trigger a second repair generation. Both generations currently run inside one research operation deadline.

Kimi's Chat Completions API documents `response_format: { "type": "json_schema" }` for Structured Output, including a `json_schema` payload. The provider can therefore advertise this capability to the AI SDK.

## Architecture

Provider selection, model capabilities, and provider-specific protocol behavior have separate responsibilities:

- `ProviderName` selects a provider and its credentials, base URL, and default model.
- A typed model capability registry records behavior verified for a specific provider and model combination. The initial capability is `structuredOutputs`.
- Optional provider strategy hooks are reserved for protocol differences that cannot be expressed as capabilities, such as request-body transformation or assistant metadata replay. This change does not add a strategy implementation.

Capabilities are model-specific rather than provider-wide. A known `kimi:kimi-k2.6` entry enables structured output. Unknown or overridden models use conservative defaults unless their capabilities are explicitly registered. DeepSeek remains unchanged and does not inherit Kimi capabilities.

The registry configures the existing AI SDK adapter; it does not implement a custom JSON converter or duplicate AI SDK request and response handling.

## Scope

- Add a typed model capability registry with conservative defaults.
- Register native structured output support for `kimi:kimi-k2.6`.
- Derive `supportsStructuredOutputs` for the Kimi OpenAI-compatible adapter from the selected model's registered capabilities.
- Keep the DeepSeek configuration unchanged until it is independently verified.
- Keep the 120-second per-operation timeout and the existing one-repair policy unchanged.
- Keep the research workflow, event protocol, prompts, and Zod schemas unchanged.

## Data Flow

1. `getResearchModel()` resolves the selected provider and model ID.
2. The capability registry resolves the exact provider-model pair, falling back conservatively for unknown models.
3. The Kimi OpenAI-compatible provider receives the resolved `supportsStructuredOutputs` value.
4. `generateText` receives `Output.object({ schema })` as it does today.
5. For registered `kimi-k2.6`, the adapter serializes the schema as Kimi's `response_format.type = json_schema` request instead of falling back to `json_object`.
6. Kimi constrains the response to the requested schema.
7. The application still performs its final Zod parse and retains one repair attempt for genuinely malformed or incompatible output.

## Error Handling

Provider, authentication, rate-limit, cancellation, and timeout failures remain single-call failures. Only structured-output generation or validation failures may use the existing repair attempt. Public research failure events remain unchanged.

## Testing and Verification

- Add capability tests for the registered Kimi model and conservative unknown-model fallback.
- Add a provider unit test asserting that default `kimi-k2.6` enables `supportsStructuredOutputs`.
- Assert that an unregistered Kimi model does not automatically enable the capability.
- Assert that DeepSeek remains unchanged.
- Run the full unit test suite, typecheck, lint, and production build.
- Inspect the production server output to confirm the previous `responseFormat` warning no longer appears during a live Kimi planning request.
- Run one live quick-depth research smoke test and confirm planning advances beyond the initial model operation without an avoidable repair request.

## Non-Goals

- Enabling or validating DeepSeek structured output.
- Increasing operation or route timeouts.
- Removing the repair path.
- Replacing AI SDK structured generation with tool calls or custom JSON parsing.
- Implementing provider strategy hooks before a verified protocol difference requires them.
