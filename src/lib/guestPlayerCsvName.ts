import { buildGuestPlayerDbFields, splitFullName } from '@/lib/profileName';

const FIRST_HEADERS = new Set(['first_name', 'firstname', 'voornaam', 'first name']);
const LAST_HEADERS = new Set(['last_name', 'lastname', 'achternaam', 'last name']);
const FULL_HEADERS = new Set(['full_name', 'fullname', 'name', 'naam']);

function findHeaderIndex(headers: string[], candidates: Set<string>): number {
  return headers.findIndex((h) => candidates.has(h));
}

function findLegacyNameIndex(headers: string[]): number {
  return headers.findIndex(
    (h) =>
      (h.includes('name') || h.includes('naam')) &&
      !h.includes('first') &&
      !h.includes('last') &&
      h !== 'username',
  );
}

/** Resolve guest name DB fields from a CSV row (structured or legacy full_name column). */
export function guestNameFieldsFromCsvRow(
  headers: string[],
  values: string[],
): { fields: ReturnType<typeof buildGuestPlayerDbFields>; missingName: boolean } {
  const firstIdx = findHeaderIndex(headers, FIRST_HEADERS);
  const lastIdx = findHeaderIndex(headers, LAST_HEADERS);
  const fullIdx = findHeaderIndex(headers, FULL_HEADERS);

  if (firstIdx >= 0) {
    const first = values[firstIdx]?.trim() ?? '';
    const last = lastIdx >= 0 ? values[lastIdx]?.trim() ?? '' : '';
    const fields = buildGuestPlayerDbFields(first, last);
    return { fields, missingName: !fields.full_name };
  }

  const nameIdx = fullIdx >= 0 ? fullIdx : findLegacyNameIndex(headers);
  const fullName = nameIdx >= 0 ? values[nameIdx]?.trim() ?? '' : '';
  const split = splitFullName(fullName);
  const fields = buildGuestPlayerDbFields(split.first_name, split.last_name);
  return { fields, missingName: !fields.full_name };
}

/** Whether CSV has a usable name column (structured first and/or legacy full name). */
export function csvHasGuestNameColumn(headers: string[]): boolean {
  if (findHeaderIndex(headers, FIRST_HEADERS) >= 0) return true;
  if (findHeaderIndex(headers, FULL_HEADERS) >= 0) return true;
  return findLegacyNameIndex(headers) >= 0;
}
