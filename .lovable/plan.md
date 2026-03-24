

# Translate Public Invoice Payment Status Screens

## Problem
The success/processing/error/paid screens on the public invoice page use hardcoded English strings. Since the URL already contains the language prefix (e.g. `/nl/`), these should use `useTranslation()` which is already imported.

## Changes

### 1. Add translation keys to all 5 language files
**Files: `src/i18n/locales/{en,nl,es,de,fr}/common.json`**

Add an `"invoice"` section with keys for:
- `paymentProcessing` — "Payment Processing" / "Betaling wordt verwerkt"
- `paymentProcessingDescription` — "Your payment is being processed..." / "Je betaling wordt verwerkt..."
- `paymentReceived` — "Payment Received" / "Betaling ontvangen"
- `paymentReceivedDescription` — "This invoice has been paid. Thank you!" / "Deze factuur is betaald. Bedankt!"
- `invoiceNotFound` — "Invoice Not Found" / "Factuur niet gevonden"
- `invoiceNotFoundDescription` — "This invoice link is invalid or has expired." / "Deze factuurlink is ongeldig of verlopen."
- `createAccountToViewInvoices` — "Create account to view your invoices" / "Maak een account aan om je facturen te bekijken"

### 2. Replace hardcoded strings in `PublicInvoicePay.tsx`
**File: `src/pages/PublicInvoicePay.tsx`**

Use `const { t } = useTranslation();` (already imported) to replace all hardcoded English strings in:
- `PostPaymentCTA` component (line 77)
- Paid state (lines 362-363)
- Processing state (lines 378-379)
- Error/not-found state (lines 394-395)
- SEO title/description attributes in each state

### Files
- `src/i18n/locales/en/common.json` — Add invoice translation keys
- `src/i18n/locales/nl/common.json` — Add Dutch invoice translations
- `src/i18n/locales/es/common.json` — Add Spanish invoice translations
- `src/i18n/locales/de/common.json` — Add German invoice translations
- `src/i18n/locales/fr/common.json` — Add French invoice translations
- `src/pages/PublicInvoicePay.tsx` — Replace hardcoded strings with `t()` calls

