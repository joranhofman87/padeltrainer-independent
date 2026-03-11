

## Wire Logger Errors to PostHog `$exception`

### What
Replace the sessionStorage-based `sendToMonitoring` in `logger.ts` with `posthog.capture('$exception', ...)` so all `logger.error` calls (including global handlers) flow into the PostHog dashboard automatically.

### Changes

**`src/lib/logger.ts`** — Update `sendToMonitoring`:
- Import `posthog` from `posthog-js`
- Replace the TODO/sessionStorage block with `posthog.capture('$exception', { $exception_message, $exception_type, $exception_stack_trace_raw, ...context })`
- Keep sessionStorage as a fallback for dev/non-production where PostHog isn't initialized
- Also send `warn`-level entries as non-fatal exceptions

No other files need changes — every `logger.error` call across the codebase already routes through `sendToMonitoring`, and the global handlers in `main.tsx` already call `logger.error`.

