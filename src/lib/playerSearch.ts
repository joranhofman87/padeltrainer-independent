/**
 * Shared player search used by every surface that lists or picks players
 * (players tables, invoice picker, email campaign, booking dialogs), so the
 * search behavior can never diverge between views.
 *
 * Matching: case- and diacritic-insensitive substring match. The query is
 * split on whitespace and EVERY token must match at least one searchable
 * field (name, email, phone, business name) — so "jan padel" finds Jan whose
 * business is Padel BV, and "jans" finds Jan Jansen.
 */

export interface SearchablePlayerFields {
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  billing_business_name?: string | null;
}

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const digitsOnly = (value: string): string => value.replace(/\D/g, '');

export function playerMatchesQuery(player: SearchablePlayerFields, query: string): boolean {
  const tokens = normalize(query.trim()).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystacks = [
    player.full_name,
    player.email,
    player.phone,
    player.billing_business_name,
  ]
    .filter((v): v is string => Boolean(v))
    .map(normalize);

  // Phone numbers are typed with spaces/dashes and stored in mixed formats —
  // compare digits-to-digits so "06 1234" finds "+31612340000".
  const phoneDigits = player.phone ? digitsOnly(player.phone) : '';

  return tokens.every((token) => {
    if (haystacks.some((field) => field.includes(token))) return true;
    const tokenDigits = digitsOnly(token);
    return tokenDigits.length >= 3 && phoneDigits.includes(tokenDigits);
  });
}

export function filterPlayersByQuery<T extends SearchablePlayerFields>(
  players: T[],
  query: string,
): T[] {
  if (!query.trim()) return players;
  return players.filter((p) => playerMatchesQuery(p, query));
}

/**
 * Single combobox search string for cmdk-based pickers (CommandInput matches
 * against the item's value). Includes the same fields as playerMatchesQuery.
 */
export function playerComboboxSearchValue(player: SearchablePlayerFields): string {
  return [player.full_name, player.email, player.billing_business_name, player.phone]
    .filter(Boolean)
    .join(' ')
    .trim();
}
