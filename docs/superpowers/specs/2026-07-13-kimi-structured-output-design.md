# Kimi Structured Output Design

## Goal

Make `kimi-k2.6` planning and research generations use Kimi's native JSON Schema structured output so valid provider responses do not unnecessarily enter the repair path and consume the shared operation deadline.

## Root Cause

The research model uses AI SDK `Output.object` with Zod schemas, but the Kimi OpenAI-compatible provider does not declare `supportsStructuredOutputs`. The adapter therefore warns that schema-backed `responseFormat` is unsupported and falls back to `json_object`. JSON mode guarantees valid JSON but does not enforce the application schema, so a schema mismatch can trigger a second repair generation. Both generations currently run inside one research operation deadline.

Kimi's Chat Completions API documents `response_format: { "type": "json_schema" }` for Structured Output, including a `json_schema` payload. The provider can therefore advertise this capability to the AI SDK.

A live request with Structured Output enabled removed the adapter warning but still exceeded the operation deadline before planning completed. Kimi's model documentation explains the remaining behavior: `kimi-k2.6` enables thinking by default, while this application uses independent one-shot structured generations and does not consume or preserve `reasoning_content`. The provider-specific `thinking: { "type": "disabled" }` request field is therefore required for these bounded generations.

## Architecture

Provider selection, model capabilities, and provider-specific protocol behavior have separate responsibilities:

- `ProviderName` selects a provider and its credentials, base URL, and default model.
- A typed model capability registry records behavior verified for a specific provider and model combination. The initial capabilities are `structuredOutputs` and `thinkingMode`.
- A small Kimi request transformer maps the registered `thinkingMode` capability to Kimi's provider-specific request body. It does not parse responses or duplicate AI SDK's Structured Output conversion.
- Additional provider strategy hooks remain reserved for protocol differences such as assistant metadata replay.

Capabilities are model-specific rather than provider-wide. A known `kimi:kimi-k2.6` entry enables structured output and sets `thinkingMode: "disabled"` for bounded structured generations. Unknown or overridden models use `structuredOutputs: false` and `thinkingMode: "enabled"`; the transformer only injects an override for `"disabled"`, so conservative models retain their provider default. DeepSeek remains unchanged and does not inherit Kimi capabilities.

The registry configures the existing AI SDK adapter; it does not implement a custom JSON converter or duplicate AI SDK request and response handling.

## Scope

- Add a typed model capability registry with conservative defaults.
- Register native structured output support and disabled thinking mode for `kimi:kimi-k2.6`.
- Derive `supportsStructuredOutputs` for the Kimi OpenAI-compatible adapter from the selected model's registered capabilities.
- Add a Kimi request transformer that injects `thinking: { "type": "disabled" }` only when the selected model capability requires it.
- Keep the DeepSeek configuration unchanged until it is independently verified.
- Keep the 120-second per-operation timeout and the existing one-repair policy unchanged.
- Keep the research workflow, event protocol, prompts, and Zod schemas unchanged.

## Data Flow

1. `getResearchModel()` resolves the selected provider and model ID.
2. The capability registry resolves the exact provider-model pair, falling back conservatively for unknown models.
3. The Kimi OpenAI-compatible provider receives the resolved `supportsStructuredOutputs` value and a request transformer.
4. For registered `kimi-k2.6`, the transformer preserves the AI SDK request body and adds `thinking: { "type": "disabled" }`.
5. `generateText` receives `Output.object({ schema })` as it does today.
6. For registered `kimi-k2.6`, the adapter serializes the schema as Kimi's `response_format.type = json_schema` request instead of falling back to `json_object`.
7. Kimi performs a bounded non-thinking generation constrained to the requested schema.
8. The application still performs its final Zod parse and retains one repair attempt for genuinely malformed or incompatible output.

## Error Handling

Provider, authentication, rate-limit, cancellation, and timeout failures remain single-call failures. Only structured-output generation or validation failures may use the existing repair attempt. Public research failure events remain unchanged.

## Testing and Verification

- Add capability tests for the registered Kimi model and conservative unknown-model fallback.
- Add transformer tests proving disabled thinking is injected without mutating or dropping existing request fields, while conservative models remain unchanged.
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
- Enabling thinking for the current one-shot structured research stages.
- Adding response parsing or reasoning replay to the Kimi request transformer.
