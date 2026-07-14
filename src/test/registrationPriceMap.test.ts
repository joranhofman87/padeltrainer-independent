// Registration price-row mapping: lesson type → the right price_table row, matched by the label's
// MEANING (not array position). Pins the real production label sets so an out-of-order price table
// prices correctly, and includes a byte-identical copy of the server matcher
// (supabase/functions/_shared/registration-pricing.ts) so client and server can never diverge.
import { describe, it, expect } from 'vitest';
import { resolvePriceRowIndex } from '@/lib/registrationPriceMap';

// --- verbatim mirror of the server matcher (registration-pricing.ts) ---
function semanticMatchesServer(lessonType: string, label: string): boolean {
  const l = label.toLowerCase();
  switch (lessonType) {
    case 'private': return /priv/.test(l);
    case 'duo': return /\bduo\b/.test(l) || /(^|\D)2(\D|$)/.test(l);
    case 'group3': return /(^|\D)3(\D|$)/.test(l);
    case 'group4': return /(^|\D)4(\D|$)/.test(l);
    default: return false;
  }
}
function resolveServer(lessonType: string, orderedTypes: string[], labels: string[]): number {
  const matched: number[] = [];
  for (let i = 0; i < labels.length; i++) if (semanticMatchesServer(lessonType, labels[i] ?? '')) matched.push(i);
  if (matched.length === 1) return matched[0];
  const idx = orderedTypes.indexOf(lessonType);
  return idx >= 0 && idx < labels.length ? idx : -1;
}

describe('resolvePriceRowIndex — real production forms', () => {
  it('Najaar: out-of-order table maps each type to its correct row (was the reported bug)', () => {
    const types = ['group3', 'group4', 'duo', 'private'];
    const labels = ['Prive les (prijs p.p.)', 'Duo les (prijs p.p.)', 'Groepsles 3 spelers (prijs p.p.)', 'Groepsles 4 spelers (prijs p.p.)'];
    expect(resolvePriceRowIndex('group4', types, labels)).toBe(3); // €19 row, not the Duo (€38) row
    expect(resolvePriceRowIndex('group3', types, labels)).toBe(2);
    expect(resolvePriceRowIndex('duo', types, labels)).toBe(1);
    expect(resolvePriceRowIndex('private', types, labels)).toBe(0);
  });

  it('"N personen" forms: group3/group4 map by the number, private/duo by keyword', () => {
    const types = ['private', 'duo', 'group', 'group4', 'group3']; // server order (group not deduped)
    const labels = ['Prive les', 'Duo les (prijs p.p)', '3 personen (prijs p.p)', '4 personen (prijs p.p)'];
    expect(resolvePriceRowIndex('private', types, labels)).toBe(0);
    expect(resolvePriceRowIndex('duo', types, labels)).toBe(1);
    expect(resolvePriceRowIndex('group3', types, labels)).toBe(2);
    expect(resolvePriceRowIndex('group4', types, labels)).toBe(3);
  });

  it('membership table (kids form) falls back to positional (unchanged behaviour)', () => {
    const types = ['kids'];
    const labels = ['Leden', 'Niet leden'];
    expect(resolvePriceRowIndex('kids', types, labels)).toBe(0); // positional idx 0 — same as before
  });

  it('an aligned table still maps identically (no regression when order already matches)', () => {
    const types = ['private', 'duo', 'group3', 'group4'];
    const labels = ['Prive les', 'Duo les', 'Groepsles 3', 'Groepsles 4'];
    for (let i = 0; i < types.length; i++) expect(resolvePriceRowIndex(types[i], types, labels)).toBe(i);
  });

  it('ambiguous (multiple matches) falls back to positional, never a silent wrong pick', () => {
    const types = ['group3', 'group4'];
    const labels = ['Groepsles 3 en 4 spelers', 'Groepsles 3 en 4 spelers']; // both rows match "3" and "4"
    expect(resolvePriceRowIndex('group3', types, labels)).toBe(0); // positional
    expect(resolvePriceRowIndex('group4', types, labels)).toBe(1);
  });
});

describe('client matcher === server matcher (parity)', () => {
  const cases: { types: string[]; labels: string[] }[] = [
    { types: ['group3', 'group4', 'duo', 'private'], labels: ['Prive les', 'Duo les', 'Groepsles 3 spelers', 'Groepsles 4 spelers'] },
    { types: ['private', 'duo', 'group', 'group4', 'group3'], labels: ['Prive les', 'Duo les', '3 personen', '4 personen'] },
    { types: ['kids'], labels: ['Leden', 'Niet leden'] },
    { types: ['private', 'duo', 'group3', 'group4'], labels: ['A', 'B', 'C', 'D'] },
  ];
  for (const { types, labels } of cases) {
    for (const lt of types) {
      it(`parity: ${lt} over ${JSON.stringify(labels)}`, () => {
        expect(resolvePriceRowIndex(lt, types, labels)).toBe(resolveServer(lt, types, labels));
      });
    }
  }
});
