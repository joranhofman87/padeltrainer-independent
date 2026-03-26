

# Add Prominent Academy Branding Banner to Generated Invoice

## Current State
The generated invoice has:
- A **6px thin strip** at the top (`banner-strip`) using the accent color
- A small logo (60px) next to the "FACTUUR" title in the header

The payment page (`PublicInvoicePay.tsx`) has a much more prominent look: a **full-width colored banner** with a centered logo (or academy name in white if no logo).

## Plan

Update the HTML template in `generate-invoice/index.ts` to replace the thin strip + inline logo with a prominent branded header, similar to the payment page:

**Replace lines 80, 112-118** with:

```html
/* CSS */
.branded-header {
  background: {accentColor};
  padding: 24px;
  text-align: center;
  margin-bottom: 0;
}
.branded-header img { max-height: 48px; max-width: 200px; object-fit: contain; }
.branded-header h2 { color: white; font-size: 20px; font-weight: bold; margin: 0; }

/* HTML */
<div class="branded-header">
  {logo ? <img src="..." /> : <h2>{business_name}</h2>}
</div>
<div class="invoice-container">
  <div class="header">
    <h1 class="invoice-title">FACTUUR</h1>
    <div class="invoice-meta">...</div>
  </div>
```

This gives a full-width colored banner with centered logo (or academy name fallback in white text), followed by the invoice title and meta below — matching the payment page style.

## Changes

| File | Change |
|------|--------|
| `supabase/functions/generate-invoice/index.ts` | Replace thin `banner-strip` with full-width branded header block; move logo from inline-with-title to centered in banner; add academy name fallback when no logo |

