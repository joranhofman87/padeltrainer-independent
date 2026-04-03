

# Fix Unmatched Mentions: Actually Detect Names, Not Sentences

## Problem
The current `getUnmatchedMentions` splits notes by commas/newlines and treats each fragment as a potential name. This means entire sentences like "Ik speel nu zo'n 4 a 5 jaar" or "Geen tennisachtergrond" show up as "unmatched names." Only actual name-like phrases (e.g., "Stefan Mols", "Angelique Mutsaers", "Els van der Meulen") should be surfaced.

## Root cause
The splitting approach is too coarse — it produces sentence-length fragments. The "capitalized word" check isn't enough because Dutch sentences naturally start with capitals ("Ik speel...").

## Fix — `src/lib/suggestLinks.ts` → `getUnmatchedMentions`

Replace the fragment-based approach with a name-pattern extraction:

1. **Extract candidate names using a regex** that finds sequences of 2-4 capitalized words (optionally connected by particles like "van", "de", "der"):
   ```
   /\b([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+(?:\s+(?:van|de|den|der|het|ter|ten)\s+)?[A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+(?:\s+[A-Za-z\u00C0-\u00FF][a-z\u00E0-\u00FF]+)*)/g
   ```
   This matches things like "Stefan Mols", "Els van der Meulen", "Angelique Mutsaers" but NOT "Ik speel" (lowercase second word) or "Geen tennisachtergrond" (second word lowercase).

2. **Also match single capitalized words** that appear right after name-indicating phrases like "met ", "samen met ", "zijn ", "voorkeuren zijn " — but only if the word isn't a common Dutch/filler word.

3. **Cap fragment length**: reject any candidate longer than ~4 words (excluding particles). Real names are 2-4 words max.

4. **Filter against registrations** (same as now) — if the candidate matches an existing registration, skip it.

5. **Filter against filler words** — if all significant words in the candidate are filler, skip it.

This dramatically reduces false positives: sentences, descriptions, and single filler words won't pass the capitalization pattern.

## Files

| File | Change |
|------|--------|
| `src/lib/suggestLinks.ts` | Rewrite `getUnmatchedMentions` to use regex-based name extraction instead of fragment splitting |

