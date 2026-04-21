

## Goal
Translate the public invoice payment page (`/i/:token`) so it appears in Dutch (and other supported locales) instead of hardcoded English. This is the page a trainer's player sees when clicking a "pay invoice" link — currently labels like **Pay**, **Subtotal**, **Due date**, **Bank details** stay in English regardless of locale.

## Scope
The hardcoded strings live almost entirely in **`src/pages/PublicInvoicePay.tsx`**. Strings to move into the `invoice.*` namespace:

- Status badges: `Overdue`, `Open`
- Section labels: `From`, `To` (already keyed), `Invoice date`, `Due date`
- Line-items table headers: `Description`, `Qty`, `Price`, `Amount`
- Totals: `Subtotal`, `VAT ({rate}%)`, `Total`
- Pay button: `Pay €{amount}`, `Redirecting…`
- Bank details block: `Please transfer the amount to the bank account below`, `Bank details`, `Or pay via bank transfer`, `IBAN:`, `BIC:`, `Name:`, `Reference:`
- Footer: `Questions? Contact …`
- SEO title/description: `Invoice` / `Invoice Payment`

## Changes

### 1. Add translation keys
Extend the `invoice` block in `src/i18n/locales/{en,nl,es,de,fr,it}/common.json` with the new keys above (e.g. `pay`, `redirecting`, `subtotal`, `vat`, `total`, `qty`, `price`, `amount`, `description`, `invoiceDate`, `dueDate`, `from`, `overdue`, `open`, `bankDetails`, `bankTransferAlt`, `transferInstruction`, `iban`, `bic`, `name`, `reference`, `questionsContact`).

NL examples: Betalen, Bezig met doorsturen…, Subtotaal, BTW, Totaal, Aantal, Prijs, Bedrag, Omschrijving, Factuurdatum, Vervaldatum, Van, Verlopen, Open, Bankgegevens, Of betaal per overschrijving, Maak het bedrag over naar onderstaande rekening, Naam, Kenmerk, Vragen? Neem contact op.

### 2. Replace hardcoded strings in `PublicInvoicePay.tsx`
Wire each literal to `t("invoice.<key>")`. For interpolated strings use i18n placeholders: `t("invoice.payAmount", { amount })`, `t("invoice.vatLine", { rate })`, `t("invoice.questionsContact", { email })` rendered with `<Trans>` so the email link stays clickable.

### 3. Quick audit pass
Sweep other invoice/payment-touching components for any other lingering English literals (e.g. `CreateCustomInvoiceDialog`, `PlayerInvoicesTab` Dutch-only labels — leave those, they're already a single language by design but flag for follow-up if needed). The `EditBillingDialog` inside the same file already uses `t()`, so no change needed there.

### Out of scope
- `PlayerInvoicesTab.tsx` is currently Dutch-only (hardcoded NL). Not touched here — separate i18n pass if desired.
- Email templates and edge functions (server-side, separate locale system).

## Files touched
- `src/pages/PublicInvoicePay.tsx`
- `src/i18n/locales/{en,nl,es,de,fr,it}/common.json`

