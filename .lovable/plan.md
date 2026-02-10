
## Update Email Branding: Logo + Orange CTAs

### What changes

All 7 email-sending edge functions will be updated to use a consistent, branded email template with:

1. **Logo at the top** -- The dark SVG logo hosted publicly at `https://padeltrainer.ai/assets/logo-dark.svg` (or a PNG fallback), displayed centered at the top of every email
2. **Orange CTA buttons** -- Replace all green (`#16a34a`) and blue (`#2563eb`) button backgrounds with the brand orange `#f45d25` (matching the `.ai` color in the logo SVG)
3. **Orange accent colors** -- Replace green/blue accent text (headings, links, highlights) with `#f45d25` where appropriate. Keep red (`#dc2626`) for error/cancellation emails and amber (`#f59e0b`) for warnings/reminders as those are semantic colors.

### Brand color mapping

| Current | New | Where |
|---------|-----|-------|
| `#16a34a` (green) | `#f45d25` (brand orange) | CTA buttons, confirmation headings, success accent text, links |
| `#2563eb` (blue) | `#f45d25` (brand orange) | CTA buttons, info headings |
| `#dc2626` (red) | Keep as-is | Cancellation/rejection headings (semantic) |
| `#f59e0b` (amber) | Keep as-is | Payment reminder/review headings (semantic) |

### Shared email wrapper

To avoid repeating the logo and footer in every template, a shared `wrapEmailHtml(bodyHtml)` function will be created in each edge function that wraps the body with:

```
+----------------------------------+
|        [PadelTrainer Logo]       |
|                                  |
|     (email body content)         |
|                                  |
|  ----                            |
|  (c) 2026 PadelTrainer.ai       |
+----------------------------------+
```

The logo will be referenced as a publicly hosted image URL. Since email clients don't support SVG reliably, we'll need to either:
- Host the logo-dark.svg at a public URL and use it (Gmail/Apple Mail support SVG, Outlook doesn't)
- Or upload a PNG version for maximum compatibility

I'll use the existing `public/favicon.png` or the SVG with a PNG fallback approach. The safest option: reference the SVG from the live site URL since it's already deployed.

### Files to update

| File | Changes |
|------|---------|
| `supabase/functions/send-email/index.ts` | Add shared wrapper with logo. Replace all `#16a34a` and `#2563eb` button/accent colors with `#f45d25` across ~20 email templates |
| `supabase/functions/send-auth-email/index.ts` | Replace green button/heading/link colors with `#f45d25`. Add logo to header |
| `supabase/functions/signup-user/index.ts` | Same: replace green with orange, add logo |
| `supabase/functions/send-digest-emails/index.ts` | Replace green button/heading with `#f45d25`, add logo |
| `supabase/functions/forward-invoice/index.ts` | Add logo header, update any accent colors |
| `supabase/functions/process-onboarding-emails/index.ts` | These use custom HTML from templates so no template changes needed, but the wrapper/logo could be added around the body |
| `supabase/functions/trigger-welcome-emails/index.ts` | Same as process-onboarding -- wraps template body with logo header |

### Technical detail

The logo image tag in emails will be:
```html
<div style="text-align: center; margin-bottom: 24px;">
  <img src="https://padeltrainer.ai/assets/logo-dark.svg" 
       alt="PadelTrainer.ai" 
       width="220" height="40" 
       style="max-width: 220px; height: auto;" />
</div>
```

The text-based `<h1>PadelTrainer.ai</h1>` headers currently in auth/signup emails will be replaced with this logo image.

All CTA button styles change from:
```
background: #16a34a; color: white;
```
To:
```
background: #f45d25; color: white;
```

After updating, all 7 functions will be redeployed and tested by sending a verification email to confirm the new branding.
