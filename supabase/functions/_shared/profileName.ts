/** Shared name helpers for edge functions (keep in sync with src/lib/profileName.ts). */

export type ProfileNameFields = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
};

export function buildFullName(first?: string | null, last?: string | null): string {
  return [first?.trim(), last?.trim()].filter(Boolean).join(" ");
}

export function splitFullName(name: string): { first_name: string; last_name: string } {
  const trimmed = name.trim();
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
  const first = firstName.trim();
  const last = lastName.trim();
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
  const first = (input.firstName ?? input.first_name ?? "").trim();
  const last = (input.lastName ?? input.last_name ?? "").trim();
  if (first) {
    return buildGuestPlayerDbFields(first, last);
  }
  const legacyFull = (input.fullName ?? input.full_name ?? "").trim();
  if (legacyFull) {
    const split = splitFullName(legacyFull);
    return buildGuestPlayerDbFields(split.first_name, split.last_name);
  }
  return { first_name: null, last_name: null, full_name: "" };
}

export function getDisplayName(profile: ProfileNameFields): string {
  const first = profile.first_name?.trim() ?? "";
  const last = profile.last_name?.trim() ?? "";

  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;

  return profile.full_name?.trim() ?? "";
}

export function resolveGuestNameForInvoice(guest: ProfileNameFields): string {
  const display = getDisplayName(guest);
  if (display) return display;
  return guest.full_name?.trim() ?? "";
}
