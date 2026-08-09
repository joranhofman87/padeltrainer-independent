import { csvHasGuestNameColumn, guestNameFieldsFromCsvRow } from '@/lib/guestPlayerCsvName';

/**
 * Parsing a player-import CSV.
 *
 * Extracted from `ImportPlayersDialog` so the rules can be tested as rules. They were previously
 * expressed as `t(...)` calls inside a component, which meant the only way to ask "is a blank email
 * accepted?" was to render a dialog and upload a file — so nobody asked, and the answer was no long
 * after every other creation route had stopped requiring one.
 *
 * Errors are CODES, not sentences. The component translates them; a test can assert on them without
 * pinning a translation, and adding a language cannot change what the parser decided.
 */

/** Fatal, file-level reasons the import cannot start at all. */
export type CsvFatalReason = 'no_data_rows' | 'missing_name_column';

/** Row-level reasons a single player cannot be imported. Other rows are unaffected. */
export type CsvRowError = 'name_missing' | 'email_invalid' | 'skill_out_of_range';

export interface ParsedImportPlayer {
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  /** Normalized (trimmed, lowercased) or NULL — a Player is not required to have an address. */
  email: string | null;
  phone: string;
  skill_rating: number | null;
  notes: string | null;
  isValid: boolean;
  errors: CsvRowError[];
  /**
   * The id of the create attempt for THIS row, minted once when the file is parsed. Re-running an
   * import that half-failed replays the rows that already landed instead of duplicating them, and
   * no attribute of the person is used to recognise them (U2). Picking a new file parses again and
   * mints new ids, which is correct: that is a different import.
   */
  creationRequestId: string;
}

export type ParseImportedPlayersResult =
  | { ok: false; reason: CsvFatalReason; players?: undefined }
  | { ok: true; players: ParsedImportPlayer[]; reason?: undefined };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A supplied address must be a real one; an absent address is not an error. */
export function isValidImportEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result.map((v) => v.trim());
}

export function parseImportedPlayersCsv(
  content: string,
  newRequestId: () => string = () => crypto.randomUUID(),
): ParseImportedPlayersResult {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { ok: false, reason: 'no_data_rows' };

  const headers = parseCSVLine(lines[0].toLowerCase());
  // A NAME is the only column the file must have. An email column is optional, exactly as an email
  // is: children, walk-ins and people who decline to give an address are ordinary players, and a
  // roster exported without an address column used to be rejected outright.
  if (!csvHasGuestNameColumn(headers)) return { ok: false, reason: 'missing_name_column' };

  const emailIndex = headers.findIndex((h) => h.includes('email') || h.includes('e-mail'));
  const phoneIndex = headers.findIndex(
    (h) => h.includes('phone') || h.includes('telefoon') || h.includes('tel'),
  );
  const skillIndex = headers.findIndex(
    (h) => h.includes('skill') || h.includes('rating') || h.includes('niveau'),
  );
  const notesIndex = headers.findIndex(
    (h) => h.includes('note') || h.includes('opmerking') || h.includes('notitie'),
  );

  const players: ParsedImportPlayer[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const errors: CsvRowError[] = [];

    const { fields: nameFields, missingName } = guestNameFieldsFromCsvRow(headers, values);
    const rawEmail = emailIndex !== -1 ? values[emailIndex]?.trim() || '' : '';
    const phone = phoneIndex !== -1 ? values[phoneIndex]?.trim() || '' : '';
    const skillRaw = skillIndex !== -1 ? values[skillIndex]?.trim() : null;
    const notes = notesIndex !== -1 ? values[notesIndex]?.trim() || null : null;

    if (missingName) errors.push('name_missing');
    // A blank cell is an absent address, which is allowed. A cell with something in it is a claim
    // about how to reach this person, and a claim that is not an address is a typo worth refusing —
    // silently importing it would put a placeholder in the one field every matcher reads.
    if (rawEmail && !isValidImportEmail(rawEmail)) errors.push('email_invalid');

    let skillRating: number | null = null;
    if (skillRaw) {
      const parsed = parseFloat(skillRaw.replace(',', '.'));
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) {
        skillRating = parsed;
      } else if (!isNaN(parsed)) {
        errors.push('skill_out_of_range');
      }
    }

    players.push({
      full_name: nameFields.full_name,
      first_name: nameFields.first_name,
      last_name: nameFields.last_name,
      email: rawEmail ? rawEmail.toLowerCase() : null,
      phone,
      skill_rating: skillRating,
      notes,
      isValid: errors.length === 0,
      errors,
      creationRequestId: newRequestId(),
    });
  }

  return { ok: true, players };
}
