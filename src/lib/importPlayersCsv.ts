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
 *
 * WHICH INVARIANT THIS FILE SERVES. There are two, and review keeps collapsing them into one:
 *
 *   1. THE PLAYER ENTITY — email is OPTIONAL. A Player may exist with no address, and no attribute
 *      of a person may ever select, merge, deduplicate or reuse an identity (U2, owner 2026-08-09).
 *      An import is a creation route, so it obeys this: a file with no email column is valid, and a
 *      blank cell is an absent address rather than an error.
 *   2. A WORKFLOW THAT DELIVERS SOMETHING — email may be a REQUIRED INPUT. The public booking,
 *      payment and self-service intake flows, and the rebook-group add, each need somewhere to send
 *      a confirmation or a pay link, so they require an address as contact information (owner,
 *      2026-08-09; the rebook requirement is older still — 20260705110000, Slice C).
 *
 * The two are compatible: requiring contact details to complete a transaction says nothing about
 * who somebody IS. What is forbidden in both is using the address to answer that question.
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

export type CsvDelimiter = ',' | ';';

/**
 * Which character separates fields, decided ONCE from the header and then used for every row.
 *
 * Treating both as separators simultaneously — which is what the original did — quietly corrupts
 * the other one's data: a semicolon file whose notes column contains a comma silently gains a
 * field, and every column after it shifts. So the header votes, outside quotes, and the winner is
 * the delimiter for the whole file. A tie or neither means a single-column file, where comma is the
 * conventional answer and nothing depends on it.
 */
export function detectCsvDelimiter(headerLine: string): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const char = headerLine[i];
    if (char === '"') {
      if (inQuotes && headerLine[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (char === ',') commas++;
      else if (char === ';') semicolons++;
    }
  }
  return semicolons > commas ? ';' : ',';
}

export function parseCSVLine(line: string, delimiter: CsvDelimiter = ','): string[] {
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
    } else if (char === delimiter && !inQuotes) {
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
  // ONE leading byte-order mark, stripped before anything reads the header. Excel writes a BOM by
  // default, and with it attached the first header cell is `\uFEFFfirst_name` — which matches no
  // name column, so the whole file was refused for having no name. Only the leading one goes: a
  // U+FEFF anywhere else is content, and this is not the place to decide it is not.
  const text = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { ok: false, reason: 'no_data_rows' };

  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = parseCSVLine(lines[0].toLowerCase(), delimiter);
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
    const values = parseCSVLine(lines[i], delimiter);
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
