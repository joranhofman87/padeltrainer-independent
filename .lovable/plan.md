## Fix XSS in TermsAcceptance.tsx

Replace the local `SafeHTML` helper (which sets `innerHTML` without sanitization) with the existing `SafeHtml` component from `@/components/ui/SafeHtml` that runs DOMPurify.

### Changes
- `src/components/booking/TermsAcceptance.tsx`
  - Remove the inline `SafeHTML` function and unused `useRef`/`useEffect` imports.
  - Import `SafeHtml` from `@/components/ui/SafeHtml`.
  - Replace `<SafeHTML html={terms} className="..." />` with `<SafeHtml html={terms} className="..." />`.

### Out of scope
- Other components (audit confirms only this file uses the unsanitized pattern).