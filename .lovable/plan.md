
# Plan: Fix app.padeltrainer.ai Redirect Loop

## Problem Analysis

After reviewing the codebase, I identified two issues:

1. **Primary Issue - Custom Domain Setup**: The `app.padeltrainer.ai` subdomain may not be properly configured in Lovable. The project's published URL is `padeltrainer.lovable.app`, not the custom subdomain. This can cause SSL/redirect loops.

2. **Secondary Issue - Storage Mismatch**: There's an inconsistency in how `pendingRole` is stored and retrieved between Auth.tsx (uses localStorage) and SelectRole.tsx (uses sessionStorage).

## Solution

### Step 1: Verify Domain Configuration

You need to check the custom domain settings in Lovable:

1. Go to Project Settings → Domains
2. Ensure `app.padeltrainer.ai` is added as a custom domain (separate from `padeltrainer.ai`)
3. Add an A record for the subdomain:
   - Type: A
   - Name: app
   - Value: 185.158.133.1
4. Wait for DNS propagation and SSL provisioning

### Step 2: Fix Storage Consistency

I'll update `SelectRole.tsx` to check both localStorage and sessionStorage for backward compatibility, ensuring the `pendingRole` value is found regardless of where it was stored.

```text
Current (SelectRole.tsx line 22):
  const storedPendingRole = sessionStorage.getItem('pendingRole');

Updated:
  const storedPendingRole = 
    localStorage.getItem('pendingRole') || 
    sessionStorage.getItem('pendingRole');
```

### Step 3: Add Debug Logging (Optional)

To help diagnose future issues, add console logging to the DomainRouter to show which route set is being served:

```typescript
// In DomainRouter.tsx
console.log('[DomainRouter] hostname:', hostname, 
  'isAppDomain:', isAppDomain, 
  'isMarketingDomain:', isMarketingDomain);
```

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/SelectRole.tsx` | Fix storage check to use both localStorage and sessionStorage |
| `src/components/DomainRouter.tsx` | Add debug logging for domain detection |

## Verification Steps

After implementation:
1. Publish the project
2. Verify `app.padeltrainer.ai` is listed and Active in Lovable domain settings
3. Visit `app.padeltrainer.ai` - should show auth page
4. Visit `app.padeltrainer.ai/admin` - should work correctly

## Technical Notes

- The routing logic in `DomainRouter.tsx` is correct and properly detects `app.padeltrainer.ai`
- The domain helpers in `src/lib/domains.ts` correctly reference the production URLs
- The issue is likely infrastructure (DNS/SSL) rather than code
