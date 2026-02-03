

# Cleanup Plan: DomainRouter Redirect Logic

## Summary
Clean up the `RedirectToAppDomain` component by removing debug logs, fixing a React hooks violation, and removing unused code.

## Changes

### 1. Fix React Hooks Violation
The `useEffect` is currently called inside an `if` statement, which violates React's rules of hooks. Restructure to call hooks unconditionally.

### 2. Remove Debug Console Logs
Replace the `console.log` statements with the `logger` utility (or remove entirely) to keep production logs clean.

### 3. Remove Unused Variable
The `isLocalhost` variable is declared but never used - remove it.

### 4. Simplify the Component
Streamline the logic while keeping the user-friendly fallback UI.

---

## Technical Details

**File:** `src/components/DomainRouter.tsx`

**Before (problematic):**
```typescript
if (isProductionMarketing) {
  useEffect(() => { ... }); // ❌ Hook inside conditional
  return <div>...</div>;
}
```

**After (correct):**
```typescript
useEffect(() => {
  if (isProductionMarketing) {
    window.location.replace(targetUrl);
  }
}, [isProductionMarketing, targetUrl]);

if (isProductionMarketing) {
  return <div>...</div>; // ✅ Just the render, no hook
}
```

**Changes Summary:**
- Move `useEffect` outside conditional block
- Replace `console.log` with `logger.debug` 
- Remove unused `isLocalhost` variable
- Keep the helpful fallback UI with "click here" link

