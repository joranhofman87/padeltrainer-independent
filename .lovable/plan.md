

# Add Invoice Settings for Academies

## Summary
Add invoice/business settings (business name, KvK, BTW, IBAN, logo, etc.) to the Academy Settings page, mirroring what trainers already have.

## Step 1: Database Migration
Add invoice-related columns to `academy_profiles`:
- `business_name` (text, nullable)
- `business_address` (text, nullable)
- `kvk_number` (text, nullable)
- `btw_number` (text, nullable)
- `iban` (text, nullable)
- `bic` (text, nullable)
- `payment_terms_days` (integer, default 14)
- `default_vat_rate` (numeric, default 21)
- `invoice_forward_emails` (text[], nullable)
- `invoice_logo_url` (text, nullable)
- `invoice_prefix` (text, default 'INV')
- `invoice_next_number` (integer, default 1)

## Step 2: Create `AcademyInvoiceSettingsCard` Component
New file: `src/components/academy/AcademyInvoiceSettingsCard.tsx`

Adapted from the trainer's `InvoiceSettingsCard` but:
- Takes `academyId` instead of `userId`
- Saves to `academy_profiles` table instead of `trainer_profiles`
- Uses `academy` translation namespace
- Logo upload path: `invoice-logos/academy-{academyId}.{ext}`

Same fields: business name, address, KvK, BTW, IBAN, BIC, payment terms, VAT rate, invoice prefix/numbering, forward emails, logo upload.

## Step 3: Add to Academy Settings Page
In `AcademySettings.tsx`, add the `AcademyInvoiceSettingsCard` after the Payment Connect card and before General Terms. Pass `activeAcademy.id` as prop.

## Step 4: Translations
Add invoice settings keys to `en/academy.json` and `nl/academy.json` (reuse trainer translation patterns).

## Files
- **Migration**: Add 12 columns to `academy_profiles`
- `src/components/academy/AcademyInvoiceSettingsCard.tsx` — New component
- `src/pages/academy/AcademySettings.tsx` — Import and render the new card
- `src/i18n/locales/en/academy.json` — Add invoice settings translations
- `src/i18n/locales/nl/academy.json` — Add Dutch translations

