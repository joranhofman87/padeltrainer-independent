// @vitest-environment node
/**
 * U1c prerequisite 3 — the client half of academy deletion.
 *
 * The database behaviour is proven against real PostgreSQL by
 * `scripts/db/academy-deletion-integration.mjs` (it has to be: the catalogue-drift guard pins a
 * fingerprint of the real schema, and the lock plan can only be witnessed with two sessions). What
 * is proven here is the contract the admin surface must keep:
 *
 *   * the legacy eight-delete sequence is GONE — asserted against the page source, because a module
 *     test cannot notice code that is still sitting there;
 *   * a blocked preview never gets a destructive confirmation;
 *   * confirmation carries only the server-issued digest and version, never counts;
 *   * a stale preview clears the confirmation instead of retrying.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchAcademyDeletionPreview, confirmAcademyDeletion, isPreviewBlocked, isStalePreview,
  nonZeroEntries, totalDeleted, totalDetached, totalMutated, AcademyDeletionError,
  type AcademyDeletionPreview,
} from '../lib/academyDeletion';

const ACADEMY = '11111111-1111-4111-8111-111111111111';

const previewFixture = (over: Partial<AcademyDeletionPreview> = {}): AcademyDeletionPreview => ({
  preview_version: 1,
  academy_profile_id: ACADEMY,
  deleted: { academy_trainers: 2, academy_player_metadata: 1, guest_players: 0 },
  detached: { availability_slots: 3, 'invoices.person_id': 1 },
  mutated: { persons: 1, person_merge_review: 0 },
  blockers: [],
  digest: 'a'.repeat(64),
  ...over,
});

/** A supabase stub that records exactly what was sent to the edge function. */
const makeSupabase = (reply: { data?: unknown; error?: unknown }) => {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: {
      functions: {
        invoke: (name: string, opts: { body: Record<string, unknown> }) => {
          calls.push({ name, ...opts.body });
          return Promise.resolve(reply);
        },
      },
    } as never,
  };
};

describe('the legacy client-side delete sequence is gone', () => {
  const page = readFileSync('src/pages/admin/AdminAcademies.tsx', 'utf8');

  it('AdminAcademies no longer deletes academy tables directly', () => {
    // These were the eight separately committed statements. Mollie is the one that mattered most:
    // it was destroyed before the invoice check could refuse.
    // academy_profiles is deliberately absent from this list: the page still UPDATEs it for bulk
    // verification, which is unrelated. The `.delete()` assertion below is what covers it.
    for (const table of [
      'academy_managers', 'academy_locations', 'academy_trainers', 'academy_trainer_invitations',
      'academy_profile_views', 'academy_followers', 'academy_mollie_accounts',
    ]) {
      expect(`${table}:${page.includes(`.from("${table}")`)}`).toBe(`${table}:false`);
    }
    expect(page.includes('.delete()')).toBe(false);
  });

  it('it goes through the edge-function helpers instead', () => {
    expect(page).toContain('fetchAcademyDeletionPreview');
    expect(page).toContain('confirmAcademyDeletion');
  });

  it('all three destructive categories are rendered, not just deleted', () => {
    // an operator shown only "deleted" is not being told that someone else's invoice loses its
    // person reference, or that a shared person gets rewritten
    for (const id of ['preview-deleted', 'preview-detached', 'preview-mutated']) {
      expect(`${id}:${page.includes(`data-testid="${id}"`)}`).toBe(`${id}:true`);
    }
    expect(page).toContain('totalMutated(preview)');
  });

  it('the confirm button is gated on the preview', () => {
    expect(page).toContain('confirmDisabled={!preview || isPreviewing || isPreviewBlocked(preview)}');
  });
});

describe('preview display helpers', () => {
  it('separates what is deleted from what is merely detached', () => {
    const p = previewFixture();
    expect(totalDeleted(p)).toBe(3);
    expect(totalDetached(p)).toBe(4);
    // a scrubbed audit row and a rewritten shared person are neither destroyed nor untouched
    expect(totalMutated(p)).toBe(1);
    // availability_slots is detached — it must never be presented as deleted
    expect(Object.keys(p.deleted)).not.toContain('availability_slots');
  });

  it('hides empty relations so the rows that matter are visible', () => {
    expect(nonZeroEntries(previewFixture().deleted))
      .toEqual([['academy_player_metadata', 1], ['academy_trainers', 2]]);
  });

  it('reports a blocked preview as blocked', () => {
    expect(isPreviewBlocked(previewFixture())).toBe(false);
    expect(isPreviewBlocked(previewFixture({ blockers: [{ code: 'HAS_INVOICES', count: 2 }] }))).toBe(true);
    expect(isPreviewBlocked(null)).toBe(false);
  });
});

describe('fetching a preview', () => {
  it('asks the edge function and returns its payload', async () => {
    const { client, calls } = makeSupabase({ data: { preview: previewFixture() } });
    const p = await fetchAcademyDeletionPreview(client, ACADEMY);
    expect(calls[0]).toMatchObject({ name: 'admin-academy-deletion', action: 'preview', academy_profile_id: ACADEMY });
    expect(p.digest).toHaveLength(64);
  });

  it('surfaces a structured refusal code', async () => {
    const { client } = makeSupabase({ error: { message: 'nope', context: { body: { error: 'Deletion refused.', code: 'BLOCKED' } } } });
    await expect(fetchAcademyDeletionPreview(client, ACADEMY)).rejects.toMatchObject({ code: 'BLOCKED' });
  });
});

describe('confirming', () => {
  it('sends ONLY the server-issued digest and version — never counts', async () => {
    const { client, calls } = makeSupabase({ data: { success: true } });
    await confirmAcademyDeletion(client, previewFixture());

    expect(calls[0]).toEqual({
      name: 'admin-academy-deletion',
      action: 'confirm',
      academy_profile_id: ACADEMY,
      expected_digest: 'a'.repeat(64),
      preview_version: 1,
    });
    // the counts the operator was shown must not travel back; the server recomputes them
    expect(JSON.stringify(calls[0])).not.toContain('deleted');
    expect(JSON.stringify(calls[0])).not.toContain('detached');
  });

  it('refuses locally on a blocked preview, without calling the function at all', async () => {
    const { client, calls } = makeSupabase({ data: { success: true } });
    await expect(confirmAcademyDeletion(client, previewFixture({ blockers: [{ code: 'HAS_INVOICES', count: 1 }] })))
      .rejects.toMatchObject({ code: 'BLOCKED' });
    // a UI that offers an action it knows will be rejected teaches people to click through warnings
    expect(calls).toHaveLength(0);
  });

  it('carries audit_incomplete through when the failure stamp itself failed', async () => {
    const { client } = makeSupabase({
      error: { message: 'x', context: { body: { error: 'Deletion refused.', code: 'BLOCKED', audit_incomplete: true } } },
    });
    await expect(confirmAcademyDeletion(client, previewFixture()))
      .rejects.toMatchObject({ code: 'BLOCKED', auditIncomplete: true });
  });
});

describe('stale handling', () => {
  it('treats PREVIEW_STALE and catalogue drift as stale', () => {
    expect(isStalePreview(new AcademyDeletionError('x', 'PREVIEW_STALE'))).toBe(true);
    expect(isStalePreview(new AcademyDeletionError('x', 'ACADEMY_DELETION_CATALOG_DRIFT'))).toBe(true);
  });

  it('does NOT treat an ordinary blocker or an unknown error as stale', () => {
    // a blocked preview is still accurate — it must not trigger a re-preview loop
    expect(isStalePreview(new AcademyDeletionError('x', 'BLOCKED'))).toBe(false);
    expect(isStalePreview(new Error('network'))).toBe(false);
  });

  it('the page clears the preview and re-previews on stale, and never auto-retries deletion', () => {
    const page = readFileSync('src/pages/admin/AdminAcademies.tsx', 'utf8');
    const start = page.indexOf('const handleDeleteAcademy');
    // search for the component's return AFTER the handler — indexOf from 0 finds an earlier one
    const handler = page.slice(start, page.indexOf('\n  return (', start));
    expect(handler).toContain('isStalePreview(error)');
    expect(handler).toContain('setPreview(null)');
    expect(handler).toContain('openDeleteDialog(deletingAcademy)');
    // exactly one confirm call in the handler — a retry would be a second one
    expect(handler.match(/confirmAcademyDeletion\(/g) ?? []).toHaveLength(1);
  });
});
