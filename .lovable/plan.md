

# Add Role Selection Page Before Signup

## Overview
Create a new `/app/signup` route that presents a role picker (Player, Trainer, Academy, Club) before directing users to the appropriate signup form. Direct links from pricing pages and other CTAs skip this page entirely — they already link to `/app/signup/trainer`, `/app/signup/player`, etc.

## New Page: `src/pages/SignupRolePicker.tsx`
A clean card-based selection page with 4 options:
- **Player** — "Find trainers and improve your game" → `/app/signup/player`
- **Trainer** — "Offer training and grow your business" → `/app/signup/trainer`
- **Academy** — "Manage your academy and trainers" → `/app/signup/academy`
- **Club** — "Manage your venue and community" → `/app/signup/club`

Each option is a clickable card with an icon, title, and one-line description. Preserves any `?redirect=` query param by forwarding it to the target signup URL. Includes a "Back to home" link and an "Already have an account? Sign in" link.

Fully translated — add keys to `auth.json` for all 4 languages (nl, en, de, es).

## Routing: `src/components/DomainRouter.tsx`
Add route: `<Route path="/app/signup" element={<SignupRolePicker />} />`
Place it **before** the specific `/app/signup/*` routes so it only matches the exact `/app/signup` path.

## Update Auth page links: `src/pages/Auth.tsx`
Replace the current "Join as Player / Join as Trainer" two-button grid (lines 283-294) with a single link:
- "Don't have an account? **Sign up**" → links to `/app/signup`

This keeps the login page clean and funnels all new signups through the role picker (unless they came from a direct link).

## Files to modify
| File | Change |
|------|--------|
| `src/pages/SignupRolePicker.tsx` | **Create** — role selection page |
| `src/components/DomainRouter.tsx` | Add `/app/signup` route |
| `src/pages/Auth.tsx` | Replace 2-button signup grid with single "Sign up" link |
| `src/i18n/locales/*/auth.json` | Add `signupPicker` translation keys (4 languages) |

