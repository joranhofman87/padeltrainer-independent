import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
await db.exec(`
  CREATE ROLE service_role;
  CREATE SCHEMA IF NOT EXISTS auth;
  -- minimal stand-ins for the ALTER targets so the migration applies
  CREATE TABLE public.trainer_mollie_accounts (trainer_id uuid PRIMARY KEY);
  CREATE TABLE public.academy_mollie_accounts (academy_profile_id uuid PRIMARY KEY);
`);

const mig = readFileSync('supabase/migrations/20260614100000_stripe_idempotency_mollie_token_lock.sql', 'utf8');
await db.exec(mig);

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const claim = async (id, type, sub, created) =>
  (await db.query(`SELECT public.claim_stripe_event($1,$2,$3,$4) AS c`, [id, type, sub, created])).rows[0].c;
const newer = async (sub, created) =>
  (await db.query(`SELECT public.stripe_subscription_has_newer_activation($1,$2) AS n`, [sub, created])).rows[0].n;

// Dedup: first delivery claims, retry does not.
ok((await claim('evt_1', 'invoice.paid', 'sub_A', 200)) === true, 'CLAIM: first delivery of an event is claimed', null);
ok((await claim('evt_1', 'invoice.paid', 'sub_A', 200)) === false, 'CLAIM: duplicate delivery of the same event id is rejected', null);

// Ordering: a renewal (created=200) is recorded for sub_A above.
ok((await newer('sub_A', 100)) === true, 'ORDERING: a delete created BEFORE the recorded renewal is stale (skip)', null);
ok((await newer('sub_A', 300)) === false, 'ORDERING: a delete created AFTER the renewal is NOT stale (proceed)', null);
ok((await newer('sub_other', 100)) === false, 'ORDERING: unrelated subscription has no newer activation', null);
ok((await newer(null, 100)) === false, 'ORDERING: null subscription id is safe (no false positive)', null);

// A checkout.session.completed also counts as an activation for ordering.
await claim('evt_2', 'checkout.session.completed', 'sub_B', 500);
ok((await newer('sub_B', 400)) === true, 'ORDERING: checkout.session.completed counts as a newer activation', null);
// A payment_failed does NOT count as an activation.
await claim('evt_3', 'invoice.payment_failed', 'sub_C', 500);
ok((await newer('sub_C', 400)) === false, 'ORDERING: payment_failed is not an activation (does not block a later delete)', null);

console.log(fail === 0 ? '\nALL stripe idempotency/ordering checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
