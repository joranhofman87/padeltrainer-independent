## Audit results: Dutch UX across the invoice flow

I traced the full path (email → public invoice → pay → optional signup → app) and found a few real gaps. The good news: most copy is already translated. The bad news: a handful of hardcoded strings, a broken variable, and a language-mismatched link mean a Dutch recipient can land on a partly-English page.

### Issues found

**1. Email subject is broken (high severity)**
In `supabase/functions/send-invoice-email/index.ts` line 227:
```ts
const subject = `${l.subject} ${invoice.invoice_number} - ${businessName}`;
```
`l` is not defined; the translations dictionary is `tr`. This throws at runtime and the email send fails. Should be `tr.subject`.

**2. Public invoice URL is hardcoded to `/nl/...`**
Same file: the link in the email always points at `https://padeltrainer.ai/nl/academies/{slug}/pay/{token}`, regardless of the recipient's language. An English/Spanish/etc. recipient lands on the Dutch URL. Should use the recipient `language` in the path.

**3. Caller sites don't pass `language` to the email function**
`BulkInvoiceEmailDialog` passes `language` correctly. But the single-send mutations and "send all drafts" loops in:
- `src/pages/trainer/TrainerInvoices.tsx` (3 invocations)
- `src/pages/academy/AcademyInvoices.tsx` (3 invocations)
- `src/components/trainer/InvoiceList.tsx` (2 invocations)

…do not pass `language`, so the function falls back to `nl`. That's fine when the trainer is Dutch, but inconsistent with how the bulk dialog works and breaks for non-Dutch academies. Pass `i18n.language` from each call site.

**4. Hardcoded Dutch toasts (cosmetic but breaks parity)**
- `TrainerInvoices.tsx`: "Factuur verzonden naar ...", "X verzonden / X zonder e-mail / X mislukt", "X facturen verwerkt".
- `AcademyInvoices.tsx`: same toast message hardcoded in `handleEmailSubmitAndSend`.
- These are seen by trainers/academy managers, not guests, but they are mixed Dutch/English depending on the path.

**5. `forward-invoice` (notification to trainer) is fully Dutch**
This sends a copy of the invoice to the trainer/academy's own forwarding addresses. Currency formatted `nl-NL`, subject prefixed `Factuur`, body in Dutch. Acceptable if all platform users are Dutch-speaking trainers; flag for confirmation rather than change.

**6. Public invoice page (`PublicInvoicePay.tsx`) — language detection**
The page itself uses `useTranslation("common")` and all strings are translated (NL keys verified: `stepReviewDetails`, `stepPay`, `editBillingDetails`, `paymentReceived`, `optionalAccountDescription`, `goToMyAccount`, etc.). However the displayed language depends on the browser's `i18next-browser-languagedetector`, not on the invoice language. Combined with issue #2 (URL is hardcoded `/nl/`), a Dutch recipient on a non-Dutch browser still sees an English page even though the URL says `/nl/`. Fix by reading the locale segment from the URL (`/nl/...`) and calling `i18n.changeLanguage('nl')` on mount of the public invoice route.

**7. Post-payment signup → app**
`PostPaymentCTA` builds `/app/signup/player?...&redirect=/app/player`. The signup page and the player app already follow `i18n.language`, so once #6 is fixed the whole flow stays in Dutch end-to-end.

### Changes to make

1. **`supabase/functions/send-invoice-email/index.ts`**
   - Replace `${l.subject}` with `${tr.subject}` on line 227.
   - Build `publicUrl` with the recipient `language` segment instead of hardcoded `nl`. Fallback to `nl` when language is missing.

2. **Pass `language` from every caller**
   - `src/pages/trainer/TrainerInvoices.tsx`: add `language: i18n.language` to all 3 `invoke("send-invoice-email", ...)` bodies.
   - `src/pages/academy/AcademyInvoices.tsx`: same for the 2 calls that don't already pass it.
   - `src/components/trainer/InvoiceList.tsx`: same for both calls.

3. **Translate the hardcoded Dutch toasts**
   - Move "Factuur verzonden naar {email}", the "X verzonden / X zonder e-mail / X mislukt" summary, and the "{n} facturen verwerkt" string into `invoices.*` keys in `nl/trainer.json` and `en/trainer.json` (and the academy equivalents). Use `t(...)` at the call sites.

4. **`PublicInvoicePay.tsx` — pin the page language to the URL locale**
   - On mount, read the first path segment (`nl|en|es|de|fr|it`); if it differs from `i18n.language`, call `i18n.changeLanguage(seg)`. This guarantees the recipient sees the page in the language the email link encoded.

5. **`forward-invoice` — confirm with you before changing**
   - Currently fully Dutch. Leave as-is unless you want it localized per academy/trainer language.

### Out of scope

- Changing email signing domain, CTA design, or payment provider behavior.
- Any business logic in Mollie webhooks or invoice generation.
- The trainer-facing `forward-invoice` content unless you confirm.

### Files touched

- `supabase/functions/send-invoice-email/index.ts`
- `src/pages/PublicInvoicePay.tsx`
- `src/pages/trainer/TrainerInvoices.tsx`
- `src/pages/academy/AcademyInvoices.tsx`
- `src/components/trainer/InvoiceList.tsx`
- `src/i18n/locales/nl/trainer.json`, `src/i18n/locales/en/trainer.json` (and academy equivalents) for the toast strings

### Open question for you

Should `forward-invoice` (the copy that goes to the academy's own inbox) also follow the recipient language, or stay Dutch? Today it is fully Dutch with `Factuur` prefix.
