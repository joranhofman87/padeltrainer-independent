

# Implement Cookie-Based Auth Sharing Across Subdomains

## Overview

Switch the Supabase auth session storage from `localStorage` to cookies scoped to `.padeltrainer.ai`, so users stay logged in on both the marketing site and the app domain. Since there are no real users yet, no migration is needed.

## Changes

### 1. New File: `src/lib/cookieStorage.ts`

Create a custom storage adapter that implements `getItem`, `setItem`, and `removeItem` using `document.cookie`:

- In production: sets `domain=.padeltrainer.ai; Secure; SameSite=Lax; path=/`
- In development (localhost / lovable.app): no domain restriction, just `path=/`
- Cookie expiry: 365 days (Supabase handles token refresh internally)
- Handles URL-encoding of values for safe cookie storage

### 2. New File: `src/lib/supabaseClient.ts`

Create a wrapper that re-exports a properly configured Supabase client:

```typescript
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { cookieStorage } from './cookieStorage';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = createClient<Database>(URL, KEY, {
  auth: {
    storage: cookieStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
```

This avoids editing the auto-generated `src/integrations/supabase/client.ts`.

### 3. Update All Imports (~50 files)

Find-and-replace all:
```
from "@/integrations/supabase/client"
```
to:
```
from "@/lib/supabaseClient"
```

This affects approximately 50 files across `src/lib/`, `src/hooks/`, `src/pages/`, and `src/components/`.

### 4. Update `src/components/marketing/MarketingLayout.tsx`

Now that `useAuth()` works on the marketing domain, update the header:

- If `user` exists: show "Dashboard" button (linking to role-based dashboard) instead of "Sign In"
- If no `user`: show "Sign In" as today
- Apply to both desktop and mobile menu sections

### 5. Update `src/pages/TrainerProfile.tsx`

Remove auth guards that hide buttons on the marketing domain:

- **Line 419**: Remove `user && role === 'player'` guard on hero "Book Lesson" button -- show to everyone. If not logged in, the BookLesson page handles the redirect.
- **Line 738**: Same for lessons-section "Book a Lesson" button
- **Line 777**: Same for sidebar "Book to Connect" button
- All three buttons use `getAppUrl('/book/...')` to navigate to the app domain for the actual booking flow

### 6. Update `src/components/waitingList/WaitingListCard.tsx`

The auth check now works on the marketing domain, so the existing `!user` redirect logic will function correctly. Update the redirect to go to the app domain auth page with a return URL:

```typescript
window.location.href = getAppUrl(`/auth?redirect=${encodeURIComponent(window.location.href)}`);
```

## Technical Details

- The auto-generated `src/integrations/supabase/client.ts` is never touched
- Cookie key is the default Supabase storage key: `sb-ppkbhdiiqdusdeatgdft-auth-token`
- Cookie size: Supabase JWT tokens are ~2KB, well within the 4KB limit
- `SameSite=Lax` prevents CSRF while allowing top-level navigations
- `Secure` flag ensures HTTPS-only in production
- No `HttpOnly` (must be JS-readable for the client SDK -- same security profile as localStorage)
- Development mode auto-detects localhost/lovable.app and skips domain scoping
