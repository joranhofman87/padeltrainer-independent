

# Update Invoice INV-2026-0055 with Missing Extra Costs

## Situation
INV-2026-0055 for Joran Hofman was created **before** the latest edge function deployment. The `auto-create-invoice` function already has the correct logic to include extra costs and split payments — future invoices will be correct.

This invoice just needs a one-time manual patch, same as we did for INV-2026-0009 and INV-2026-0051.

## Action
Use a temporary edge function to update INV-2026-0055:

1. **Query** the invoice to get its current line items, booking count, and linked cycle's extra costs + split settings
2. **Add** the missing "Baanhuur PAZ avond (per sessie) (1/2)" line item (€18.00 × sessions, 0% VAT)
3. **Recalculate** subtotal, vat_amount, vat_breakdown, and total
4. **Set** `pdf_url = null` to force PDF regeneration
5. **Delete** the temporary edge function after use

Same approach as the previous invoice patches.

