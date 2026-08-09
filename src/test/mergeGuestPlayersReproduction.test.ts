// @vitest-environment node
/**
 * `merge_guest_players` is ~340 lines. U2 needed four of them added in the middle of it, and the
 * only safe way to do that in a new migration is to reproduce the shipped body verbatim and splice.
 * "Verbatim" is not something a human reviewer can verify by reading a wall of unchanged SQL — the
 * repo has already lost an insert column that way once — so it is verified here instead.
 *
 * The check is exact: strip the inserted block from the new definition and what remains must be
 * BYTE-IDENTICAL to the shipped one. A dropped statement, a renamed variable or a reordered UPDATE
 * fails this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SHIPPED = 'supabase/migrations/20261115100000_u1c_prereq_membership_repoint.sql';
const REPRODUCED = 'supabase/migrations/20261122100000_u2_merge_keeps_create_commands.sql';

/** The whole `CREATE OR REPLACE FUNCTION public.merge_guest_players(...) ... $$;` block. */
function extractMerge(file: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('CREATE OR REPLACE FUNCTION public.merge_guest_players');
  expect(`${file} defines merge_guest_players: ${start >= 0}`).toBe(`${file} defines merge_guest_players: true`);
  const end = src.indexOf('\n$$;', start);
  expect(`${file} terminates the body: ${end > start}`).toBe(`${file} terminates the body: true`);
  return src.slice(start, end + '\n$$;'.length);
}

/** Everything U2 added, anchored on its own comment and the statement it precedes. */
const INSERTED =
  /\n {2}-- U2\. The durable create-command record[\s\S]*?\n {2}END IF;\n\n(?= {2}DELETE FROM public\.guest_players WHERE id = p_source_guest_id;)/;

describe('the reproduced merge_guest_players differs from the shipped one only by the U2 insert', () => {
  it('strips back to a byte-identical body', () => {
    const shipped = extractMerge(SHIPPED);
    const reproduced = extractMerge(REPRODUCED);

    expect(INSERTED.test(reproduced)).toBe(true);
    expect(reproduced.replace(INSERTED, '\n')).toBe(shipped);
  });

  it('the insert actually repoints both columns of the command record', () => {
    const reproduced = extractMerge(REPRODUCED);
    const inserted = reproduced.match(INSERTED)?.[0] ?? '';

    // guest column: unconditional, the source guest always dies in a merge
    expect(inserted).toMatch(
      /UPDATE public\.player_create_commands\n\s+SET guest_player_id = p_target_guest_id\n\s+WHERE guest_player_id = p_source_guest_id;/,
    );
    // person column: ONLY when the source person actually dies, and only onto a real successor.
    // Repointing unconditionally would hand a surviving person's commands to somebody else.
    expect(inserted).toMatch(
      /IF v_src_person_dies AND v_tgt_person IS NOT NULL THEN\n\s+UPDATE public\.player_create_commands\n\s+SET person_id = v_tgt_person\n\s+WHERE person_id = v_src_person;\n\s+END IF;/,
    );
  });

  it('the strip is a real check — a body with one statement removed does NOT pass it', () => {
    // Otherwise a comparison that always succeeds would look exactly like this test passing.
    const shipped = extractMerge(SHIPPED);
    const mutated = shipped.replace(
      '  DELETE FROM public.guest_players WHERE id = p_source_guest_id;\n',
      '',
    );
    expect(mutated).not.toBe(shipped);
    expect(mutated.replace(INSERTED, '\n')).not.toBe(shipped);
  });
});
