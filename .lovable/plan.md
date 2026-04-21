

## Goal
Make the app recover gracefully when chunk loads time out (Cloudflare 524) or fail after a deploy, instead of leaving users stuck on the "Something went wrong" screen.

## Problem
From the screenshot:
1. `Failed to fetch dynamically imported module: …/Home-_KC2Kg8o.js` — the lazy-loaded Home chunk failed (likely a `524` timeout fetching it).
2. `graduation-cap-…js` returned `524` (Cloudflare origin timeout).
3. `Uncaught TypeError: Cannot read properties of undefined (reading 'q')` from `v2.js` — this is the **Reditus** affiliate script throwing during init.

The current `ErrorBoundary` does auto-reload on chunk-load errors, but only **once per minute**. Because the user already auto-reloaded once and the chunk fetch is *still* slow/timing out, the second failure shows the fallback UI.

## Changes

### 1. `src/components/ErrorBoundary.tsx` — smarter chunk recovery
- Increase the auto-reload window to **3 attempts in 5 minutes** instead of "once per 60s". After 3 attempts, show the fallback (so we don't loop forever on a truly broken deploy).
- Add a small delay (500ms) before reload to give Cloudflare/origin a moment to recover from the 524.
- Also detect the error in `getDerivedStateFromError` so we trigger reload before rendering the broken fallback (less flash).
- Keep the existing logger call for non-chunk errors.

### 2. `src/main.tsx` — harden Reditus script + add chunk-error window listener
- Wrap the Reditus `gr('initCustomer', …)` / `gr('track', …)` calls in a guard that catches the `'q'` undefined TypeError (it happens when the script half-loads). Already in a `try/catch`, but also catch errors thrown on the `gr` queue init by checking `(window as any).gr?.q` exists or falling back silently.
- Add a global `window.addEventListener('vite:preloadError', …)` listener (Vite emits this when a dynamic import fails) — when fired, trigger the same throttled reload logic. This catches the error *before* React's ErrorBoundary, useful when the failure happens during route preloading rather than render.

### 3. `index.html` — preconnect hint for chunks (small perf win)
- Add `<link rel="preconnect" href="https://padeltrainer.ai" crossorigin>` so chunk fetches start their TCP/TLS handshake earlier. (Only if not already there — will verify during implementation.)

## Out of scope
- Investigating the Cloudflare 524 itself (origin server timeout) — that's an infra issue with the static asset host, not an app bug. The app changes above make the app *resilient* to those timeouts; fixing the root cause requires Cloudflare/hosting investigation which we can do as a follow-up if 524s persist.
- Removing Reditus entirely (separate decision).

## Files touched
- `src/components/ErrorBoundary.tsx`
- `src/main.tsx`
- `index.html` (preconnect, if missing)

## Note for the user
Right now, a hard refresh (**Cmd/Ctrl + Shift + R**) on the affected browser will get you unstuck immediately. The changes above prevent this from happening again to other users.

