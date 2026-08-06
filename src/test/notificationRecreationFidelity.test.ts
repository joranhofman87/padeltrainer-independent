import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A MIGRATION THAT RECREATES A FUNCTION MUST START FROM THE NEWEST DEFINITION OF IT.
 *
 * `CREATE OR REPLACE FUNCTION` overwrites whatever is deployed. So a migration that lifts a
 * function from an OLDER file in order to change one predicate silently reverts every correction
 * made in between — and nothing complains, because the SQL is valid and the intended new predicate
 * is present. It is the quietest way to un-fix a bug in this repository.
 *
 * Not hypothetical: the occurrence-boundary migration first lifted `admin_notification_readiness`
 * from 20261029100000 instead of 20261030100000 and silently dropped the round-2 digest-group
 * count. One realpg assertion happened to notice.
 *
 * A general heuristic cannot do this job — every legitimate edit also "loses" text, so a
 * whole-repo scan flags each ordinary correction and means nothing. What works is exact: for each
 * function the notification audit migrations recreate, name the newest PRIOR definition and the
 * behaviour that must survive the lift. A future recreation that starts from the wrong file fails
 * here with the reason spelled out.
 */

const MIG = (f: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8');

const AUDIT = '20261104100000_notif_audit_event_occurrence_boundary.sql';

/** the body of one definition: from its CREATE to the `$$;` that closes it */
function bodyOf(src: string, fn: string): string {
  const start = src.search(new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i'));
  if (start < 0) throw new Error(`${fn}: no definition found`);
  const term = /\n(?:END\s+)?\$\$;\n/g;
  term.lastIndex = start;
  const m = term.exec(src);
  if (!m) throw new Error(`${fn}: unterminated definition`);
  return src.slice(start, m.index + m[0].length);
}

/**
 * fn → [the newest definition BEFORE the audit migration, what that definition contributed].
 * Each phrase is a behaviour, not a formatting detail: losing it means losing the fix that
 * introduced it.
 */
const LIFTED: Array<[string, string, string[]]> = [
  ['claim_notification_outbox_batch', '20261028100000_notif_n5_activation_boundary.sql', [
    'stuck_in_processing',                    // the stale reap
    'tenant_restricted',                      // the live academy-cap cancel
    'notif_channel_kill_gate',                // N4 M2, and it must stay FIRST
  ]],
  ['materialize_notification_digest_groups', '20261028100000_notif_n5_activation_boundary.sql', [
    'single_item_oversize',                   // the oversize chunk arm
    'pg_try_advisory_xact_lock',              // the nonblocking per-key serialization
    'notif_digest_canonical_key',
  ]],
  ['claim_notification_digest_group', '20261030100000_notif_n5_round2_dispatch_boundary.sql', [
    'half_open',                              // the breaker's probe branch
    'uncertain_deadline_at',                  // the uncertainty window
    'age_out',                                // the uncertainty deadline
    'notif_digest_finalize_group',
  ]],
  ['admin_notification_readiness', '20261030100000_notif_n5_round2_dispatch_boundary.sql', [
    'non-terminal group(s) predate',          // ROUND 2's group hop — the one that was lost
    'pre_activation_backlog_eligible_count',
    'durable_activation_boundary',
  ]],
  ['enqueue_notification', '20261101100000_notif_audit_marketing_unsubscribe_seam.sql', [
    'marketing_unsubscribed',                 // the audit round-1 unsubscribe seam
    'no_deliverable_channel',
  ]],
  ['notif_activation_boundary_guard', '20261028100000_notif_n5_activation_boundary.sql', [
    'is already active since',
    'append-only',
    'path is immutable',
  ]],
  ['notify_review_received', '20260913100000_notification_pilot_review_received.sql', [
    'review_received_trainer',
  ]],
  ['enqueue_booking_notification', '20260926100000_booking_notification_enqueue_rpc.sql', [
    'booking_request_staff',
    'booking_cancelled_player',
  ]],
];

describe('the audit migration recreates each function from its newest definition', () => {
  const audit = MIG(AUDIT);

  it.each(LIFTED)('%s keeps what %s contributed', (fn, priorFile, phrases) => {
    const prior = bodyOf(MIG(priorFile), fn);
    const lifted = bodyOf(audit, fn);
    for (const phrase of phrases) {
      // the phrase must genuinely come from the named prior definition — a pin that names
      // behaviour the source never had would pass vacuously forever
      expect(prior, `${priorFile} does not contain ${JSON.stringify(phrase)} — the pin is stale`)
        .toContain(phrase);
      expect(lifted, `${fn} in ${AUDIT} dropped ${JSON.stringify(phrase)}: it was lifted from an older definition than ${priorFile}`)
        .toContain(phrase);
    }
  });

  it('names every function the audit migration recreates — a new one cannot be added unpinned', () => {
    const defined = [...audit.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi)]
      .map((m) => m[1].toLowerCase());
    // the functions this migration AUTHORS rather than lifts
    const authored = new Set(['notif_outbox_occurrence_guard', 'notif_activation_min_occurred_at',
      'admin_notification_activation_boundaries']);
    const pinned = new Set(LIFTED.map(([fn]) => fn));
    const unpinned = [...new Set(defined)].filter((fn) => !pinned.has(fn) && !authored.has(fn));
    expect(unpinned).toEqual([]);
  });
});
