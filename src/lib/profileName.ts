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

/** Split full_name into first token + remainder (same algorithm as DB backfill). */
export function splitFullName(name: string): { first_name: string; last_name: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { first_name: '', last_name: '' };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: '' };
  }
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

/** DB fields for guest_players insert/update from structured name inputs. */
export function buildGuestPlayerDbFields(firstName: string, lastName: string): {
  first_name: string | null;
  last_name: string | null;
  full_name: string;
} {
  const first = firstName.trim();
  const last = lastName.trim();
  return {
    first_name: first || null,
    last_name: last || null,
    full_name: buildFullName(first, last),
  };
}

/** Prefill form fields from guest row (structured first, else split full_name). */
export function prefillGuestNameFields(guest: ProfileNameFields & { full_name: string }): {
  first_name: string;
  last_name: string;
} {
  if (guest.first_name?.trim()) {
    return {
      first_name: guest.first_name.trim(),
      last_name: guest.last_name?.trim() ?? '',
    };
  }
  return splitFullName(guest.full_name);
}

/** Prefill registration/profile forms (structured first, else split full_name). */
export function prefillProfileNameFields(profile: ProfileNameFields): {
  first_name: string;
  last_name: string;
} {
  if (profile.first_name?.trim()) {
    return {
      first_name: profile.first_name.trim(),
      last_name: profile.last_name?.trim() ?? '',
    };
  }
  return splitFullName(profile.full_name ?? '');
}

export type RegistrationNameInput = {
  firstName?: string;
  lastName?: string;
  first_name?: string;
  last_name?: string;
  fullName?: string;
  full_name?: string;
};

/** Resolve guest/intake name fields from structured and/or legacy full name. */
export function resolveRegistrationNameFields(
  input: RegistrationNameInput,
): { first_name: string | null; last_name: string | null; full_name: string } {
  const first = (input.firstName ?? input.first_name ?? '').trim();
  const last = (input.lastName ?? input.last_name ?? '').trim();
  if (first) {
    return buildGuestPlayerDbFields(first, last);
  }
  const legacyFull = (input.fullName ?? input.full_name ?? '').trim();
  if (legacyFull) {
    const split = splitFullName(legacyFull);
    return buildGuestPlayerDbFields(split.first_name, split.last_name);
  }
  return { first_name: null, last_name: null, full_name: '' };
}

/** Invoice / display name for a guest (structured preferred, then full_name). */
export function resolveGuestNameForInvoice(guest: ProfileNameFields): string {
  const display = getDisplayName(guest);
  if (display) return display;
  return guest.full_name?.trim() ?? '';
}

/** Prefer first_name, else first token of full_name. */
export function getFirstName(profile: ProfileNameFields): string {
  const first = profile.first_name?.trim();
  if (first) return first;

  const legacy = profile.full_name?.trim();
  if (!legacy) return '';

  return legacy.split(/\s+/)[0] ?? '';
}
