/** Shared name helpers for edge functions (keep in sync with src/lib/profileName.ts). */

export type ProfileNameFields = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
};

/** Callers feed these helpers raw request payloads; coerce non-strings to "" so they never throw. */
function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildFullName(first?: string | null, last?: string | null): string {
  return [toTrimmedString(first), toTrimmedString(last)].filter(Boolean).join(" ");
}

export function splitFullName(name: string): { first_name: string; last_name: string } {
  const trimmed = toTrimmedString(name);
  if (!trimmed) {
    return { first_name: "", last_name: "" };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "" };
  }
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

export function buildGuestPlayerDbFields(firstName: string, lastName: string): {
  first_name: string | null;
  last_name: string | null;
  full_name: string;
} {
  const first = toTrimmedString(firstName);
  const last = toTrimmedString(lastName);
  return {
    first_name: first || null,
    last_name: last || null,
    full_name: buildFullName(first, last),
  };
}

export type RegistrationNameInput = {
  firstName?: string;
  lastName?: string;
  first_name?: string;
  last_name?: string;
  fullName?: string;
  full_name?: string;
};

export function resolveRegistrationNameFields(
  input: RegistrationNameInput,
): { first_name: string | null; last_name: string | null; full_name: string } {
  const first = toTrimmedString(input.firstName ?? input.first_name);
  const last = toTrimmedString(input.lastName ?? input.last_name);
  if (first) {
    return buildGuestPlayerDbFields(first, last);
  }
  const legacyFull = toTrimmedString(input.fullName ?? input.full_name);
  if (legacyFull) {
    const split = splitFullName(legacyFull);
    return buildGuestPlayerDbFields(split.first_name, split.last_name);
  }
  return { first_name: null, last_name: null, full_name: "" };
}

export function getDisplayName(profile: ProfileNameFields): string {
  const first = toTrimmedString(profile.first_name);
  const last = toTrimmedString(profile.last_name);

  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;

  return toTrimmedString(profile.full_name);
}

export function resolveGuestNameForInvoice(guest: ProfileNameFields): string {
  const display = getDisplayName(guest);
  if (display) return display;
  return toTrimmedString(guest.full_name);
}
