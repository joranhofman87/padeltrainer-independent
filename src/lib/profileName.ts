export type ProfileNameFields = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
};

/** Trim and join first + last with a single space. */
export function buildFullName(first?: string | null, last?: string | null): string {
  return [first?.trim(), last?.trim()].filter(Boolean).join(' ');
}

/** Prefer structured names, then legacy full_name. */
export function getDisplayName(profile: ProfileNameFields): string {
  const first = profile.first_name?.trim() ?? '';
  const last = profile.last_name?.trim() ?? '';

  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;

  return profile.full_name?.trim() ?? '';
}

/** Prefer first_name, else first token of full_name. */
export function getFirstName(profile: ProfileNameFields): string {
  const first = profile.first_name?.trim();
  if (first) return first;

  const legacy = profile.full_name?.trim();
  if (!legacy) return '';

  return legacy.split(/\s+/)[0] ?? '';
}
