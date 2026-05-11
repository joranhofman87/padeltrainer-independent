# Revoke invoice public_token after payment + tighten referrer

## Problem

`invoices.public_token` (UUID v4) is unguessable, but:

1. Token stays valid forever — even after the invoice is paid/cancelled. A leaked URL keeps revealing PII (player name/address/BTW) and amounts indefinitely.
2. The `/pay/:token` URL leaks via `Referer` headers when users click outbound links from the pay page (existing memory `mem://security/public-invoice-privacy` already masks PII server-side after payment, but the URL itself still ends up in third-party logs).

`get-public-invoice` already returns only status info when `status IN ('paid','cancelled')`, so the PII window is mostly closed today. Remaining gaps: explicit revocation column + restricted referrer.

## Fix

### 1. Schema (migration)

Add to `public.invoices`:

```sql
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS public_token_revoked_at timestamptz;
```

Trigger to auto-revoke on terminal status:

```sql
CREATE OR REPLACE FUNCTION public.revoke_invoice_public_token()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('paid','cancelled')
     AND COALESCE(OLD.status,'') NOT IN ('paid','cancelled')
     AND NEW.public_token_revoked_at IS NULL THEN
    NEW.public_token_revoked_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_revoke_invoice_public_token
BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.revoke_invoice_public_token();
```

Backfill existing paid/cancelled rows so they're immediately revoked:

```sql
UPDATE public.invoices
SET public_token_revoked_at = COALESCE(paid_at, updated_at, now())
WHERE status IN ('paid','cancelled') AND public_token_revoked_at IS NULL;
```

### 2. Edge functions — enforce revocation

**`supabase/functions/get-public-invoice/index.ts`**
- Add `public_token_revoked_at` to the select.
- After fetch, if `public_token_revoked_at` is set, return `404 { error: "Invoice not found" }` (same shape as missing — don't even leak existence).

**`supabase/functions/create-invoice-payment/index.ts`**
- Same select + early reject if revoked, so attackers can't re-spawn a Mollie payment via a leaked URL after the original invoice is paid.

**`supabase/functions/update-public-invoice-details/index.ts`**
- Same revocation check before allowing edits.

### 3. Referrer policy

`index.html` `<head>` — add globally:

```html
<meta name="referrer" content="strict-origin-when-cross-origin" />
```

`src/pages/PublicInvoicePay.tsx` — set page-level stricter override via `react-helmet-async`:

```tsx
<Helmet>
  <meta name="referrer" content="no-referrer" />
</Helmet>
```

This prevents the full `/pay/:token` URL from being sent in `Referer` to Mollie, fonts CDN, or anything the user clicks from the pay page.

## Verification

- `psql` row check: paid invoice now has `public_token_revoked_at IS NOT NULL`.
- `curl` `get-public-invoice` with a paid token → returns `404 Invoice not found` (was `already_paid` shape before; we want full silence now).
- DevTools on `/pay/:token` → confirm `<meta name="referrer" content="no-referrer">` present and outgoing requests show no `Referer`.

## Out of scope

- Rotating the token format to something shorter / non-UUID (current entropy is already sufficient).
- Adding a separate audit log for token usage (could be follow-up if abuse is observed).
- Email scanner pre-fetch protection (would need one-time-link + interstitial; bigger UX change).
