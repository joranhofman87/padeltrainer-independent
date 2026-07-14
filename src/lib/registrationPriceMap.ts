/**
 * Maps a lesson type (group3 / group4 / duo / private / custom) to the correct row of a
 * registration form's free-text `price_table`.
 *
 * The price table rows carry trainer-authored LABELS ("Groepsles 4 spelers", "4 personen", …),
 * not lesson-type keys. Historically both the public form (price indication) and the server
 * (invoice) matched a type to a row by ARRAY POSITION — which silently mis-priced any form whose
 * rows were entered in a different order than its lesson_types, and diverged between client and
 * server for the `group` alias. This resolves by the label's MEANING instead, with a positional
 * fallback so anything it can't classify behaves exactly as before (no regression).
 *
 * SHARED CONTRACT: supabase/functions/_shared/registration-pricing.ts mirrors this exactly.
 * Keep the two in lockstep (golden-tested in src/test/registrationPriceMap.test.ts).
 */

/** A standalone digit (word-ish boundary) — avoids lookbehind for broad JS-engine support. */
const has = (label: string, re: RegExp): boolean => re.test(label);

function semanticMatches(lessonType: string, label: string): boolean {
  const l = label.toLowerCase();
  switch (lessonType) {
    case 'private':
      return has(l, /priv/); // Prive / Privé / Private
    case 'duo':
      return has(l, /\bduo\b/) || has(l, /(^|\D)2(\D|$)/);
    case 'group3':
      return has(l, /(^|\D)3(\D|$)/);
    case 'group4':
      return has(l, /(^|\D)4(\D|$)/);
    default:
      // 'group' (generic, ambiguous) and custom types: no reliable label signal → positional.
      return false;
  }
}

/**
 * @param lessonType   the selected lesson type
 * @param orderedTypes the canonical type order the table was historically indexed by (fallback)
 * @param labels       price_table row labels, in table order
 * @returns the index into price_table for this type, or -1 if none applies
 */
export function resolvePriceRowIndex(lessonType: string, orderedTypes: string[], labels: string[]): number {
  // 1. Semantic match — use it only when EXACTLY ONE row matches, so an ambiguous table can never
  //    silently override a correct positional layout.
  const matched: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (semanticMatches(lessonType, labels[i] ?? '')) matched.push(i);
  }
  if (matched.length === 1) return matched[0];

  // 2. Positional fallback (legacy behaviour).
  const idx = orderedTypes.indexOf(lessonType);
  return idx >= 0 && idx < labels.length ? idx : -1;
}
