

# Fix: Third-Party Script Errors Crashing the App

## Problem

Three issues visible in the screenshot:

1. **Reditus `v2.js` script** throws `TypeError: Cannot read properties of undefined (reading 'q')`. This is a third-party script error that the global error handler in `main.tsx` catches and logs loudly, but it does NOT crash React — it's just noise in the console.

2. **Facebook CDN 403 errors** — Two image requests to `fbcdn.net` returning 403 Forbidden. These are likely trainer/academy social images with expired tokens. Not actionable.

3. **The real crash** — The `dangerouslySetInnerHTML` reconciliation issue we've been fixing. The Reditus script modifies DOM nodes that React is tracking, causing React to crash during reconciliation. This triggers the ErrorBoundary, which shows the "Something went wrong" page and effectively reloads the app.

## Root Cause

The Reditus script (`v2.js`) manipulates the DOM globally. When it touches nodes inside React's tree, React crashes on the next render cycle. The global error handler also fires for cross-origin script errors (showing "Script error." with no useful info), adding console noise.

## Fix — Two Changes

### 1. Filter third-party errors from global handler (`src/main.tsx`)

The global `window.addEventListener('error')` handler should ignore errors from third-party scripts (cross-origin "Script error." events and errors from non-app scripts). This stops the noisy logging and prevents PostHog from being flooded with non-actionable exceptions.

```tsx
window.addEventListener('error', (event) => {
  // Ignore cross-origin script errors (no useful info) and third-party scripts
  if (!event.filename || event.message === 'Script error.' 
      || !event.filename.includes(window.location.hostname)) {
    return;
  }
  logger.error('Unhandled error', ...);
});
```

### 2. Wrap Reditus script loading with error isolation (`src/main.tsx`)

Add `try/catch` around Reditus initialization and attach an `onerror` handler to silently catch load failures:

```tsx
s.onerror = () => { /* silently ignore */ };
s.onload = () => {
  try {
    (window as any).gr?.('initCustomer', '...');
    (window as any).gr?.('track', 'pageview');
  } catch { /* silently ignore */ }
};
```

### Files to change
- `src/main.tsx` — filter global error handler + wrap Reditus in try/catch

