## Add security meta tags to index.html

Partial yes. Two different risk profiles here:

### 1. `X-Content-Type-Options: nosniff` — safe to add now
Cheap, no compatibility risk. Add as a meta tag right after the existing `referrer` meta.

```html
<meta http-equiv="X-Content-Type-Options" content="nosniff" />
```

### 2. `Content-Security-Policy` — recommend NOT adding via `<meta>`
The app loads from many third parties: Supabase (`*.supabase.co`), Sanity CDN, Google Fonts, Reditus, PostHog, Stripe, Mollie, Google Analytics, Lovable preview, etc. A strict CSP added blindly via meta will break the app immediately, and meta-tag CSP can't use `frame-ancestors` or `report-uri`, so it's strictly worse than a header.

Recommendation:
- Skip the meta CSP.
- Set `Content-Security-Policy` (and `X-Frame-Options`, `Strict-Transport-Security`) at the Cloudflare worker layer, where the existing dynamic-rendering proxy already lives. That can be rolled out in Report-Only mode first to avoid breakage.
- Treat that as a separate task (out of scope for this quick fix).

### Files
- `index.html` — add the single `X-Content-Type-Options` meta line.

No other files affected.
