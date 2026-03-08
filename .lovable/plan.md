

# Fix Impersonation "Login as User"

## Root cause

The `window.open(data.url, "_blank")` on line 49 is called inside an async callback -- by the time the edge function returns and `window.open` fires, the browser no longer considers it a direct user gesture. Modern browsers (especially Chrome and Safari) silently block this as a popup.

This likely "stopped working" due to a browser update tightening popup policies, not a code change.

## Fix

Open a blank tab **synchronously** (inside the user click handler, before the async call), then set its URL after the edge function responds. If the call fails, close the blank tab.

### File: `src/components/admin/ImpersonateUserDialog.tsx`

Replace the `handleImpersonate` function:
1. Call `window.open('about:blank', '_blank')` **before** `await` to guarantee user-gesture context
2. After the edge function returns, set `newTab.location.href = data.url`
3. If the call fails, close the pre-opened tab with `newTab.close()`

This is a single-file, ~10-line change.

