

# Fix: BrandedCycleRegistration Page Crash

## Root Cause

`CycleDetailDisplay.tsx` renders cycle descriptions using `dangerouslySetInnerHTML`. Third-party scripts (Reditus tracker confirmed erroring in console) modify the DOM inside this container. When React tries to reconcile, it finds nodes that no longer match its virtual DOM, throwing "Failed to execute 'removeChild' on 'Node'". The `FeatureErrorBoundary` catches this and shows the error screen, preventing any form submission.

## Fix

**`src/components/cycles/CycleDetailDisplay.tsx`** — Replace `dangerouslySetInnerHTML` with a ref-based approach that isolates the HTML content from React's reconciliation:

```tsx
// Instead of:
<div dangerouslySetInnerHTML={{ __html: cycle.description! }} />

// Use a ref-based component:
function SafeHTML({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = html;
  }, [html]);
  return <div ref={ref} />;
}
```

This prevents React from tracking the inner DOM nodes, so third-party script modifications won't cause reconciliation failures.

## Files to Edit

- `src/components/cycles/CycleDetailDisplay.tsx` — replace `dangerouslySetInnerHTML` with ref-based `SafeHTML`

