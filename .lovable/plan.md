

# Fix: VAT notice showing in English on Dutch pages

## Problem
The VAT notice under the pricing table always shows in English because the translation keys `detail.pricesIncludeVat` and `detail.pricesExcludeVat` are missing from all locale files. The code falls back to the hardcoded English strings.

## Fix
Add the missing translation keys to all 5 locale files (`en`, `nl`, `de`, `fr`, `es`) under a `detail` section in `cycles.json`. Also add the admin-side hint keys (`form.pricesIncludeVatHint`, `form.pricesExcludeVatHint`).

### Translations to add

| Key | EN | NL | DE | FR | ES |
|-----|----|----|----|----|-----|
| `detail.pricesIncludeVat` | All prices include VAT | Alle prijzen zijn inclusief BTW | Alle Preise verstehen sich inkl. MwSt. | Tous les prix incluent la TVA | Todos los precios incluyen IVA |
| `detail.pricesExcludeVat` | All prices exclude VAT | Alle prijzen zijn exclusief BTW | Alle Preise verstehen sich zzgl. MwSt. | Tous les prix sont hors TVA | Todos los precios excluyen IVA |

5 files modified, no logic changes needed — just adding missing keys.

