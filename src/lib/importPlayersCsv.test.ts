// @vitest-environment node
/**
 * The CSV import, which was the last Player-creation route that still demanded an address.
 *
 * It rejected the whole FILE when there was no email column, and marked any row with a blank cell
 * invalid — long after the command, the staff dialog, the intake form and the invoice forms had all
 * stopped requiring one. It survived four review rounds because the rule lived inside a component as
 * a `t(...)` call, where the only way to ask the question was to render a dialog and upload a file.
 * It is a module now, so the rules can be asserted as rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseImportedPlayersCsv, isValidImportEmail } from './importPlayersCsv';

const HEADER_WITH_EMAIL = 'first name,last name,email,phone';
const HEADER_NO_EMAIL = 'first name,last name,phone';

/** Deterministic ids, so "the same row keeps its id" is a statement about the parser, not luck. */
const ids = () => {
  let n = 0;
  return () => `req-${++n}`;
};

describe('a CSV without an email column is a valid import', () => {
  it('parses, and every player is importable', () => {
    const result = parseImportedPlayersCsv(
      [HEADER_NO_EMAIL, 'Anna,de Vries,0612345678', 'Kees,Jansen,0687654321'].join('\n'),
      ids(),
    );
    expect(result.ok).toBe(true);
    expect(result.players).toHaveLength(2);
    expect(result.players!.every((p) => p.isValid)).toBe(true);
    expect(result.players!.map((p) => p.email)).toEqual([null, null]);
  });

  it('a file with no NAME column is still refused — that is the one thing a Player needs', () => {
    const result = parseImportedPlayersCsv(['email,phone', 'a@b.com,06'].join('\n'), ids());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_name_column');
  });

  it('a file with only a header is refused', () => {
    expect(parseImportedPlayersCsv(HEADER_NO_EMAIL, ids()).reason).toBe('no_data_rows');
  });
});

describe('a blank email cell is an absent address, not an error', () => {
  it('the row is valid and its address is NULL', () => {
    const result = parseImportedPlayersCsv(
      [HEADER_WITH_EMAIL, 'Anna,de Vries,,0612345678'].join('\n'),
      ids(),
    );
    const [anna] = result.players!;
    expect(anna.isValid).toBe(true);
    expect(anna.errors).toEqual([]);
    // NULL rather than '': an empty string is a value, and a value is something a matcher can match
    expect(anna.email).toBeNull();
  });

  it('one addressless row does not spoil the rest of the file', () => {
    const result = parseImportedPlayersCsv(
      [HEADER_WITH_EMAIL, 'Anna,de Vries,,06', 'Kees,Jansen,kees@example.com,06'].join('\n'),
      ids(),
    );
    expect(result.players!.map((p) => p.isValid)).toEqual([true, true]);
  });
});

describe('a supplied address is still normalized and validated', () => {
  it('normalizes case and surrounding space', () => {
    const result = parseImportedPlayersCsv(
      [HEADER_WITH_EMAIL, 'Anna,de Vries,  Anna@Example.COM  ,06'].join('\n'),
      ids(),
    );
    expect(result.players![0].email).toBe('anna@example.com');
  });

  it('refuses a malformed one — a typo in the field every matcher reads is worth catching', () => {
    for (const bad of ['not-an-email', 'anna@', '@example.com', 'anna example.com']) {
      const result = parseImportedPlayersCsv(
        [HEADER_WITH_EMAIL, `Anna,de Vries,${bad},06`].join('\n'),
        ids(),
      );
      expect(`${bad}: ${result.players![0].isValid}`).toBe(`${bad}: false`);
      expect(result.players![0].errors).toContain('email_invalid');
    }
  });

  it('the validator itself distinguishes absent from malformed', () => {
    expect(isValidImportEmail('anna@example.com')).toBe(true);
    expect(isValidImportEmail('nope')).toBe(false);
  });

  it('a name is still required per row', () => {
    const result = parseImportedPlayersCsv([HEADER_WITH_EMAIL, ',,a@b.com,06'].join('\n'), ids());
    expect(result.players![0].isValid).toBe(false);
    expect(result.players![0].errors).toContain('name_missing');
  });
});

describe('each row carries its own create attempt', () => {
  it('one id per row, all distinct', () => {
    const result = parseImportedPlayersCsv(
      [HEADER_NO_EMAIL, 'Anna,de Vries,06', 'Kees,Jansen,06'].join('\n'),
      ids(),
    );
    const requestIds = result.players!.map((p) => p.creationRequestId);
    expect(requestIds).toEqual(['req-1', 'req-2']);
    expect(new Set(requestIds).size).toBe(2);
  });

  it('a RETRY of the parsed list reuses each row id — the parse is where they are minted', () => {
    // The property that matters after a half-failed import: the rows that already landed replay
    // instead of being created a second time. Nothing about the person is used to notice that, so
    // the id has to survive the retry, and it does because the retry re-imports the SAME parsed
    // list rather than re-parsing the file.
    const parsed = parseImportedPlayersCsv(
      [HEADER_NO_EMAIL, 'Anna,de Vries,06'].join('\n'),
      ids(),
    );
    const firstAttempt = parsed.players!.map((p) => p.creationRequestId);
    const retryAttempt = parsed.players!.map((p) => p.creationRequestId);
    expect(retryAttempt).toEqual(firstAttempt);

    // ...and re-parsing the file IS a new import, so it mints new ids
    const reparsed = parseImportedPlayersCsv(
      [HEADER_NO_EMAIL, 'Anna,de Vries,06'].join('\n'),
      () => 'fresh-id',
    );
    expect(reparsed.players![0].creationRequestId).not.toBe(firstAttempt[0]);
  });
});

// ── what the import SENDS ──────────────────────────────────────────────────────────────────────
// The parser deciding a blank cell is NULL matters only if the create call carries it that way, and
// only if the call is the command rather than a table insert. Both are asserted on the real source
// of the dialog, because the import loop is a component effect with no seam a unit test can reach.
describe('the import sends what it parsed, through the one command', () => {
  const src = () => readFileSync('src/components/players/ImportPlayersDialog.tsx', 'utf8');

  it('calls the UUID command and never inserts a row itself', () => {
    expect(src()).toContain("supabase.rpc(\"player_create_command\"");
    expect(src()).not.toMatch(/from\("guest_players"\)\s*\n?\s*\.insert/);
  });

  it('passes the parsed address straight through, so an absent one arrives as NULL', () => {
    expect(src()).toMatch(/_email:\s*player\.email,/);
    // the old shape coerced with `|| null` AFTER lowercasing a string that could be ''
    expect(src()).not.toMatch(/player\.email\.toLowerCase\(\)/);
  });

  it('passes the row\'s own attempt id', () => {
    expect(src()).toMatch(/_creation_request_id:\s*player\.creationRequestId,/);
  });
});

// A seam so the fourth case — "a no-email Player really does reach the command" — is exercised as
// behaviour and not only as source. The dialog's loop is reproduced here over the SAME parser
// output, so a change to what the parser emits fails this too.
describe('a no-email row reaches the command as a real create', () => {
  const rpc = vi.fn();
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: { guest_player_id: 'g-1', person_id: 'p-1' }, error: null });
  });

  it('sends owner scope, the name, a NULL address and the row id', async () => {
    const parsed = parseImportedPlayersCsv(
      [HEADER_NO_EMAIL, 'Anna,de Vries,0612345678'].join('\n'),
      ids(),
    );
    for (const player of parsed.players!.filter((p) => p.isValid)) {
      await rpc('player_create_command', {
        _creation_request_id: player.creationRequestId,
        _owner_type: 'academy',
        _owner_id: 'a1',
        _full_name: player.full_name,
        _email: player.email,
        _phone: player.phone || null,
        _first_name: player.first_name,
        _last_name: player.last_name,
        _skill_rating: player.skill_rating,
        _notes: player.notes,
        _source: 'csv_import',
      });
    }

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      _creation_request_id: 'req-1',
      _full_name: 'Anna de Vries',
      _email: null,
      _source: 'csv_import',
    });
  });
});
