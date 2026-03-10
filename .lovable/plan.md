

## Fix: Maximum Update Depth Error on Lesson Type Checkboxes

**Problem:** React error #185 (maximum update depth exceeded) occurs when the lesson type checkboxes render. The Radix `Checkbox` component renders a `<button>` internally. When it's inside a parent `div` with an `onClick` handler, clicking triggers both the Checkbox's internal toggle and the parent's `onClick`, causing an infinite re-render loop.

**Fix in `src/components/cycles/CycleApplicationForm.tsx` (lines 536-551):**

Move the toggle logic to `Checkbox`'s `onCheckedChange` prop and remove the parent `div`'s `onClick`. This prevents the double-trigger issue:

```tsx
<div
  key={type}
  className="flex items-center space-x-2 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
  onClick={toggle}  // REMOVE this
>
  <Checkbox
    checked={isChecked}
    onCheckedChange={toggle}  // ADD this
    tabIndex={-1}
    className="pointer-events-none"  // REMOVE this
  />
```

Replace with a `<label>` wrapping approach or simply move `onClick` to `onCheckedChange` and make the outer div a `<label>` element so clicking anywhere in the row toggles correctly without event conflicts:

```tsx
<label
  key={type}
  className="flex items-center space-x-2 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
>
  <Checkbox
    checked={isChecked}
    onCheckedChange={toggle}
  />
  <span className="font-normal cursor-pointer flex-1 m-0 text-sm">
    {t(`application.form.lessonTypes.${type}`)}
  </span>
</label>
```

This is a single-file fix in `CycleApplicationForm.tsx`.

