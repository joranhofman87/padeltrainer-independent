

# Reset Invoice Numbering to 0001

## Changes

1. **Update trainer_profiles** — Set `invoice_next_number = 1` for trainer `c0497580-1e4e-4376-93d1-5b90e9d7ca1d`
2. **Update existing invoices** — Renumber INV-0056 → INV-2026-0001, INV-0057 → INV-2026-0002 (or whichever format is used)

Two data UPDATE statements via the insert tool. No code or schema changes needed.

