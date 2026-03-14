

# Fix: Submit Button Disabled Due to Terms Component Crash

## Root Cause

The same `dangerouslySetInnerHTML` issue we fixed in `CycleDetailDisplay` also exists in `TermsAcceptance.tsx` (line 37). Third-party scripts (Reditus) modify the DOM, causing a React reconciliation crash.

When `TermsAcceptance` crashes:
1. The terms acceptance checkbox never renders
2. `termsAccepted` stays `false`
3. The submit button stays disabled (`disabled={isSubmitting || (!!cycleTerms && !termsAccepted)}` — line 750)
4. The user sees the button but cannot click it

The console confirms: "Uncaught TypeError: Cannot read properties of undefined (reading 'q')" and "Unhandled error | components='global'".

## Fix

**`src/components/booking/TermsAcceptance.tsx`** — Replace `dangerouslySetInnerHTML` with the same ref-based `SafeHTML` pattern used in `CycleDetailDisplay`:

```tsx
function SafeHTML({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = html;
  }, [html]);
  return <div ref={ref} className={className} />;
}
```

Replace line 35-38's `<div dangerouslySetInnerHTML={{ __html: terms }} />` with `<SafeHTML html={terms} className="..." />`.

Single file change, same proven pattern.

