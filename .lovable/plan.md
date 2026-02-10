

## Fix: Replace SVG Logo with PNG in All Emails

### Problem
The logo in emails uses an SVG file (`logo-dark.svg`), which Gmail, Outlook, and most email clients do not render. This causes a broken image icon on iPhone/Gmail.

### Solution
1. **Create a PNG version** of the logo and place it at `public/logo-dark.png`
2. **Update the `EMAIL_LOGO` constant** in all 5 edge functions to reference the PNG instead of the SVG

### How the PNG will be created
We'll convert the existing `src/assets/logo-dark.svg` to a high-quality PNG (440px wide for 2x retina clarity at the 220px display width). This will be placed at `public/logo-dark.png` so it's served at `https://padeltrainer.ai/logo-dark.png`.

### Files to update

All 5 files contain the same `EMAIL_LOGO` constant pointing to the SVG. Each will be updated:

| File | Change |
|------|--------|
| `supabase/functions/send-email/index.ts` | Update `EMAIL_LOGO` SVG URL to PNG |
| `supabase/functions/send-auth-email/index.ts` | Same |
| `supabase/functions/signup-user/index.ts` | Same |
| `supabase/functions/send-digest-emails/index.ts` | Same |
| `supabase/functions/forward-invoice/index.ts` | Same |

The change in each file is a single line -- replacing:
```
logo-dark.svg
```
with:
```
logo-dark.png
```

### After deployment
All 5 functions will be redeployed and a test email sent to verify the logo renders correctly in Gmail on iPhone.
