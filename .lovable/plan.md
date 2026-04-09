

# Fix: Invoice "Login to change details" redirect after signup

## Problem

When a user receives an invoice, clicks "Log in to update your details", and creates a new account, they end up on the homepage instead of being redirected back to the invoice page. This happens due to three cascading issues:

1. **Auth page never captures the `redirect` query param** — The link sends users to `/app/auth?redirect=/nl/academies/.../pay/TOKEN`, but `Auth.tsx` reads `redirectAfterLogin` from sessionStorage without ever writing it from the URL
2. **"Sign up" link loses the redirect** — The Auth page links to plain `/app/signup` without forwarding the `redirect` param
3. **New user flow discards the redirect** — When a user has no roles (new signup), the code clears `redirectAfterLogin` from sessionStorage and routes to onboarding, without preserving the redirect for after onboarding completes

## Solution

### File: `src/pages/Auth.tsx`

**A) Capture `redirect` query param on mount** — Add an effect that reads `?redirect=` from the URL and stores it in sessionStorage as `redirectAfterLogin`:

```ts
useEffect(() => {
  const redirect = searchParams.get('redirect');
  if (redirect) {
    sessionStorage.setItem('redirectAfterLogin', redirect);
  }
}, [searchParams]);
```

**B) Pass redirect to signup link** — Change the "Sign up" link (line 330) from `/app/signup` to `/app/signup?redirect=<redirect>` so the param survives if the user decides to create an account instead of logging in.

**C) Preserve redirect for new users** — In the new-user branch (lines 146-156), instead of clearing `redirectAfterLogin`, store it in `localStorage` as `redirectAfterOnboarding` so onboarding can use it after completion. The existing onboarding code (line 178 in `Onboarding.tsx`) already reads `redirectAfterOnboarding` and navigates there.

### File: `src/pages/PlayerSignup.tsx` (and other signup pages)

Already handles `?redirect` → stores as `redirectAfterOnboarding`. No changes needed.

## File Summary

| File | Change |
|---|---|
| `src/pages/Auth.tsx` | Capture redirect param, pass to signup link, preserve for onboarding |

