

# Localize Hardcoded Strings in Recently Changed Files

## Summary of findings

There are hardcoded strings across 4 files. Most are in **Dutch** (which is fine for invoice descriptions stored in the DB) but UI-facing text needs to go through `t()`. Here's the full inventory:

## File 1: `src/pages/academy/AcademyCyclusOverview.tsx`

**Hardcoded Dutch UI text (needs `t()`):**
- Line 544: `'Geen slots gevonden voor geselecteerde cycli'`
- Line 554: `'${slotIds.length} slots ${makePublic ? 'zichtbaar' : 'verborgen'} gemaakt'`
- Line 559: `'Er ging iets mis'`
- Line 568: `'Voer een geldig bedrag in'`
- Line 575: `'Geen slots gevonden voor geselecteerde cycli'`
- Line 587: `'Prijs bijgewerkt voor ${slotIds.length} slots'`
- Line 594: `'Er ging iets mis'`
- Line 610: `'Geen sessies'` (Badge)
- Line 621: `'Registratie'` (Badge)
- Line 622: `'Event'` (Badge)
- Line 652-655: `'Huidig'`, `'Toekomstig'`, `'Afgelopen'`, `'Alle'` (time filter)
- Line 693: `'cyclus'` / `'cycli'` + `'geselecteerd'`
- Line 705: `'Zichtbaar'`
- Line 714: `'Verbergen'`
- Line 723: `'Prijs wijzigen'`
- Line 747: `'Naam'` (table header)
- Line 755: `'Trainer'` (table header)
- Line 757: `'Locatie'` (table header)
- Line 758: `'Dag / Tijd'` (table header)
- Line 765: `'Periode'` (table header)
- Line 773: `'Sessies'` (table header)
- Line 781: `'Spelers'` (table header)
- Line 783: `'Prijs'` (table header)
- Line 784: `'Bezetting'` (table header)
- Line 791: `'Geen cycli gevonden'`
- Line 864: `'Prijs wijzigen voor ${selectedIds.size} cycli'`
- Line 868: `'Prijs per sessie (€)'`
- Line 879: `'Dit past de prijs aan...'`
- Line 884: `'Annuleren'`
- Line 887: `'Bezig...'` / `'Opslaan'`

## File 2: `src/pages/academy/AcademySlotDetail.tsx`

**Hardcoded English UI text (needs `t()`):**
- Line 945: `'Level'` in badge text
- Line 1059: `'yr'` (age suffix)
- Line 1064: `'Guest'` badge

## File 3: `src/components/academy/AcademyCalendarOverview.tsx`

**Hardcoded English UI text (needs `t()`):**
- Line 112: `'Rating spread: ${spread.toFixed(1)}'`
- Line 133: `'Age diff: ${diff} yr'`

## File 4: `src/lib/invoiceSync.ts`

**Hardcoded Dutch text in invoice line items:**
- Line 52: `"Invoice cancelled — all sessions were removed"` (notes field)
- Line 97: `"Training cyclus"` (fallback)
- Line 110-111: `"weken"` in descriptions
- Line 147: `"Training sessie"` fallback
- Line 191: `"per sessie"`
- Line 422: `"Training cyclus"` fallback
- Line 430: `"weken"`
- Line 461: `"per sessie"`

**Note on invoiceSync.ts**: These strings are written into invoice records (stored in DB, shown on PDFs). They can't easily use `t()` since this is a non-component utility. Options: (a) accept Dutch-only for invoices (common for NL businesses), (b) pass a locale/translate function as parameter. I recommend **(a)** — keep Dutch for invoice line items since invoices are legal documents tied to the business locale.

## Plan

### 1. Add translation keys to locale files
Add ~35 new keys to `trainer` namespace (since `AcademyCyclusOverview` uses `trainer` namespace) and `academy` namespace.

### 2. `src/pages/academy/AcademyCyclusOverview.tsx`
Replace all hardcoded Dutch strings with `t()` calls using the new keys.

### 3. `src/pages/academy/AcademySlotDetail.tsx`
Replace `'Level'`, `'yr'`, and `'Guest'` with `t()` calls.

### 4. `src/components/academy/AcademyCalendarOverview.tsx`
Replace `'Rating spread: ...'` and `'Age diff: ...'` with `t()` calls.

### 5. `src/lib/invoiceSync.ts`
Keep as-is (Dutch invoice descriptions for legal/business reasons). Only change the English `notes` field to Dutch for consistency: `"Factuur geannuleerd — alle sessies zijn verwijderd"`.

## File summary

| File | Change |
|------|--------|
| Locale JSON files (EN, NL, ES, DE, FR) | Add ~35 translation keys for cycles tab + slot detail + calendar overview |
| `src/pages/academy/AcademyCyclusOverview.tsx` | Replace ~30 hardcoded Dutch strings with `t()` |
| `src/pages/academy/AcademySlotDetail.tsx` | Replace 3 hardcoded English strings with `t()` |
| `src/components/academy/AcademyCalendarOverview.tsx` | Replace 2 hardcoded warning strings with `t()` |
| `src/lib/invoiceSync.ts` | Minor: fix English notes string to Dutch |

