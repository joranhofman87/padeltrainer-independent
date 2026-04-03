

# Fix Over-Matching in Suggested Links

## Problem
The current fuzzy matching is too loose because Dutch name particles ("van", "de", "den", "der") are extremely common. Matching on last name token "ven" (from "van de Ven") or counting 2+ token matches like "van" + "de" produces dozens of false positives. The notes say "Dennis van Schijndel, Rik Oerlemans en Job Driessen" — only those 3 should match.

## Fix

Change the matching logic in `src/components/cycles/IntakeRequestDetailSheet.tsx` (lines 155-169):

1. **Filter out Dutch name particles** from tokens: `van`, `de`, `den`, `der`, `het`, `ter`, `ten`, `een`, `het`
2. **Require the full surname (all non-particle tokens after first name) to appear** in the notes, not just any single token
3. **Raise the bar for multi-token matching**: require all significant tokens (non-particles) to match, not just 2

### New logic
```text
For each other player:
  - Extract significant tokens (remove particles like van/de/den/der)
  - If only 1 significant token (e.g. "Driessen" from "Job Driessen"):
    require that token (≥3 chars) appears in notes
  - If 2+ significant tokens (e.g. "Schijndel" from "Dennis van Schijndel"):
    require ALL significant tokens to appear in notes
```

This means "Roel Verspeek" won't match because "Verspeek" doesn't appear in the notes. "Martijn van de Ven" won't match because "Ven" doesn't appear as a mentioned name. Only exact name matches will be suggested.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Tighten fuzzy matching logic with particle filtering |

