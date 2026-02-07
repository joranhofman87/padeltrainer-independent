

# Player Business Details for Invoices + Fix Download (403)

## Two Issues to Solve

### Issue 1: Invoice Download Returns 403 for Players
The `generate-invoice` edge function only allows the **trainer** to generate/download invoices (it checks `trainerProfile.user_id !== user.id`). When a player clicks download, they get a 403 Forbidden error.

**Fix**: Update the authorization check to also allow the player linked to the invoice (`invoice.player_id === user.id`).

### Issue 2: Player Business Details on Invoices
Players should be able to store their own business details (company name, address, BTW number) that appear on invoices. Currently, the invoice only stores `player_address` and `player_btw_number`. We need to add a `player_business_name` field and let players manage these details globally (applied to all their invoices) or per-invoice.

---

## Changes

### 1. Database: Add `player_business_name` to invoices table

```sql
ALTER TABLE invoices ADD COLUMN player_business_name text;
```

This field stores the company/business name that appears on the "Aan" section of the invoice.

### 2. Fix `generate-invoice` Edge Function

- **Fix CORS headers**: Add the missing `x-supabase-client-platform` headers so browser calls don't fail silently.
- **Fix authorization**: Allow both the trainer (`trainerProfile.user_id === user.id`) AND the player (`invoice.player_id === user.id`) to generate/download the invoice.
- **Include `player_business_name`** in the HTML template output (show it above or below the player name in the "Aan" section).

### 3. Update `PlayerInvoicesTab.tsx`

**Enhance the billing details edit dialog** to include:
- Business/company name (new field)
- Address (existing)
- BTW number (existing)

When a player saves these details:
- Update the invoice record with the new fields
- Regenerate the PDF (clear `pdf_url` so next download creates a fresh one with updated details)

Also add a "Save as default" option that stores these billing details for future invoices (stored in the player's profile or a separate preferences mechanism -- simplest: store on the `profiles` table).

### 4. Add default billing fields to `profiles` table

Add columns to `profiles` so the player's business details auto-populate on new invoices:
- `billing_business_name` (text, nullable)
- `billing_address` (text, nullable)  
- `billing_btw_number` (text, nullable)

### 5. Update `auto-create-invoice` Edge Function

When creating an invoice for a player, look up the player's default billing details from `profiles` and pre-fill `player_business_name`, `player_address`, and `player_btw_number` on the invoice.

### 6. Update Invoice HTML Template

Add the business name to the "Aan" (To) section of the invoice, displayed above the player's personal name when present.

---

## Technical Summary

| File | Change |
|------|--------|
| Migration SQL | Add `player_business_name` to `invoices`, add `billing_business_name`, `billing_address`, `billing_btw_number` to `profiles` |
| `generate-invoice/index.ts` | Fix CORS, fix auth (allow player), add `player_business_name` to HTML |
| `auto-create-invoice/index.ts` | Pre-fill player billing details from `profiles` |
| `PlayerInvoicesTab.tsx` | Add business name field to edit dialog, clear `pdf_url` on save so PDF regenerates |

