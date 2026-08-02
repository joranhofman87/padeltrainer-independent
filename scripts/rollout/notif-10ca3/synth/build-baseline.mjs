// ===========================================================================
// build-baseline.mjs — load SYNTHETIC rows into the two tables #615 actually
// locks, at a measured production-equivalent scale.
//
// NOTHING here is copied from production. Every address is generated on the
// reserved example.invalid TLD (RFC 6761), which can never be delivered to, and
// no provider identifier, event payload, token, Vault value, cron command or
// auth session is read, let alone written. What IS reproduced is the only thing
// the migration's cost depends on:
//
//   row count · tuple width · index set · state/event-type distribution
//
// ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS ... STORED rewrites every
// tuple; DROP/ADD CHECK re-validates every row. Neither reads a value's meaning.
// That is why a synthetic baseline gives an HONEST timing and locking result —
// see ADR-001 §6 for the caveats that remain (physical bloat, page layout).
//
// Connection comes from argv (password-free URL) + PGPASSWORD. Never the reverse.
// ===========================================================================
import pg from 'pg';
import { readFileSync } from 'node:fs';

const url = process.argv[2];
const scalePath = process.argv[3];
if (!url || !scalePath) { console.error('usage: build-baseline.mjs <clone_url> <scale.json>'); process.exit(2); }
// a password must never travel in the URL
{
  const authority = url.replace(/^[a-z+]+:\/\//, '').split('/')[0];
  const userinfo = authority.includes('@') ? authority.slice(0, authority.lastIndexOf('@')) : '';
  if (userinfo.includes(':')) { console.error('refusing: the connection URL carries a password'); process.exit(3); }
}

const scale = JSON.parse(readFileSync(scalePath, 'utf8'));
if (scale.source !== 'measured') {
  console.error(`refusing: ${scalePath} has source="${scale.source}". A rehearsal built on invented row counts
produces an invented timing result. Fill it from a read-only production sizing
query and set source="measured" (ADR-001 §7).`);
  process.exit(4);
}
const AS = scale.tables.email_address_state;
const DE = scale.tables.email_delivery_events;
for (const [n, t] of [['email_address_state', AS], ['email_delivery_events', DE]]) {
  if (!Number.isInteger(t.rows) || t.rows <= 0) { console.error(`refusing: ${n}.rows must be a positive integer`); process.exit(4); }
  for (const k of ['heap_bytes', 'index_bytes', 'total_bytes']) {
    if (!Number.isInteger(t[k]) || t[k] <= 0) {
      console.error(`refusing: ${n}.${k} must be measured — row counts alone do not establish
scale, because a rewrite walks PAGES and a constraint validation walks indexes.
See ADR-001 section 7.`);
      process.exit(4);
    }
  }
}
const TOL = Number(scale.byte_tolerance_pct ?? 0);
// 20% is the widest band in which a measured window is still a usable bound;
// beyond that the number stops constraining anything. Widen it only deliberately
// and say so in the evidence (ADR-001 section 6.3).
if (!(TOL > 0 && TOL <= 20)) { console.error('refusing: byte_tolerance_pct must be in (0, 20]'); process.exit(4); }

// deterministic, seedless-but-reproducible generator (no Math.random: a rehearsal
// must be repeatable, and the harness forbids nondeterminism in fixtures)
let seed = 0x2f6e2b1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (dist) => {
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  let r = rnd() * total;
  for (const [k, v] of Object.entries(dist)) { r -= v; if (r <= 0) return k; }
  return Object.keys(dist)[0];
};
const pad = (s, n) => (s.length >= n ? s : s + 'x'.repeat(n - s.length));
// RFC 6761 reserved TLD — undeliverable by definition, and asserted in SQL too.
// The index leads the local part so the address is UNIQUE by construction (the
// table is keyed on it); padding only widens it to the measured average.
const DOMAIN = '@rehearsal.example.invalid';
const addr = (i, width) => pad(`s${i}`, Math.max(2, (width || 32) - DOMAIN.length)) + DOMAIN;

// The backfill walks STATE-PRODUCING events per address, so the shape of that
// history — not just the total row count — drives its cost. Weight each address
// by a p50/p90/max histogram rather than spreading events uniformly.
const hist = DE.events_per_address || {};
const p50 = Math.max(1, hist.p50 || 1), p90 = Math.max(p50, hist.p90 || p50), pmax = Math.max(p90, hist.max || p90);
const eventsFor = (k) => { const r = rnd(); return r < 0.5 ? p50 : r < 0.9 ? p90 : pmax; };

const { Client } = pg;
const c = new Client({ connectionString: url });
await c.connect();
try {
  const t0 = Date.now();
  await c.query('BEGIN');
  await c.query('TRUNCATE public.email_delivery_events, public.email_address_state');
  // with_invoice_pct drives a real FK column, so the referenced rows must exist.
  // Synthetic invoice ids only — no invoice is copied, and nothing else about
  // them is populated.
  const wantInv = Math.max(0, Math.min(100, Number(DE.with_invoice_pct || 0)));
  const invIds = [];
  if (wantInv > 0) {
    const nInv = Math.max(1, Math.ceil(DE.rows * wantInv / 100 / 4));
    for (let i = 0; i < nInv; i += 5000) {
      const chunk = Math.min(5000, nInv - i);
      const r = await c.query(
        `INSERT INTO public.invoices (id) SELECT gen_random_uuid() FROM generate_series(1, $1) RETURNING id`, [chunk]);
      for (const row of r.rows) invIds.push(row.id);
    }
  }

  // --- email_address_state: every width-driving column of the PRE-#615 shape,
  //     not a subset. provider_suppressed_active does not exist yet — the
  //     migration adds it, which is the rewrite being measured.
  const asRows = [];
  for (let i = 0; i < AS.rows; i++) {
    const st = pick(AS.state_distribution);
    asRows.push([
      addr(i, AS.avg_email_len || 32),
      st,
      st === 'ok' ? 'delivered' : st === 'complained' ? 'complained' : 'bounced',
      pad('synthetic-reason', Math.max(0, AS.avg_reason_len || 0)) || null,
    ]);
  }
  for (let i = 0; i < asRows.length; i += 5000) {
    const chunk = asRows.slice(i, i + 5000);
    const vals = chunk.map((_, k) => `($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4})`).join(',');
    await c.query(`INSERT INTO public.email_address_state
      (email, state, last_event_type, reason) VALUES ${vals}`, chunk.flat());
  }

  // --- email_delivery_events: history weighted per address -----------------
  const reason = pad('synthetic-reason', Math.max(4, DE.avg_reason_len || 24));
  let written = 0, ai = 0;
  while (written < DE.rows) {
    const rows = [];
    while (rows.length < 5000 && written < DE.rows) {
      const a = addr(ai % Math.max(1, AS.rows), AS.avg_email_len || 32);
      const n = Math.min(eventsFor(ai), DE.rows - written);
      for (let k = 0; k < n; k++) {
        const et = pick(DE.event_type_distribution);
        rows.push([
          a, et,
          et === 'bounced' ? (rnd() < 0.5 ? 'hard' : 'soft') : null,
          reason,
          rnd() * 100 < (DE.resend_event_id_pct || 0) ? `evt_${written + k}` : null,
          `msg_${written + k}`,
          invIds.length && rnd() * 100 < wantInv ? invIds[(written + k) % invIds.length] : null,
        ]);
      }
      written += n; ai++;
    }
    if (!rows.length) break;
    const vals = rows.map((_, k) =>
      `($${k * 7 + 1}, $${k * 7 + 2}, $${k * 7 + 3}, $${k * 7 + 4}, $${k * 7 + 5}, $${k * 7 + 6}, $${k * 7 + 7})`).join(',');
    await c.query(`INSERT INTO public.email_delivery_events
      (recipient_email, event_type, bounce_type, reason, resend_event_id, resend_email_id, invoice_id)
      VALUES ${vals}`, rows.flat());
  }
  await c.query('COMMIT');

  // --- bloat approximation -------------------------------------------------
  // A freshly loaded table is perfectly packed; a long-lived one is not. Update
  // then leave a documented fraction of dead tuples WITHOUT vacuuming, so the
  // rewrite has to walk a comparable number of pages. This is an approximation
  // and the ADR says so — it is not a claim of physical equivalence.
  const ratio = Number(scale.bloat?.dead_tuple_ratio || 0);
  if (ratio > 0) {
    await c.query(`UPDATE public.email_address_state SET state = state
                   WHERE ctid IN (SELECT ctid FROM public.email_address_state
                                  ORDER BY email LIMIT greatest(1, (${AS.rows} * ${ratio})::int))`);
  }
  await c.query('ANALYZE public.email_address_state');
  await c.query('ANALYZE public.email_delivery_events');

  const n1 = (await c.query('SELECT count(*)::int AS v FROM public.email_address_state')).rows[0].v;
  const n2 = (await c.query('SELECT count(*)::int AS v FROM public.email_delivery_events')).rows[0].v;
  const bad = (await c.query(`SELECT
      (SELECT count(*) FROM public.email_address_state   WHERE email           NOT LIKE '%@%.example.invalid')
    + (SELECT count(*) FROM public.email_delivery_events WHERE recipient_email NOT LIKE '%@%.example.invalid') AS v`)).rows[0].v;
  if (Number(bad) !== 0) { console.error(`FAIL: ${bad} row(s) carry a non-synthetic address`); process.exit(5); }

  // BYTE EQUIVALENCE. Row counts do not establish scale: an ACCESS EXCLUSIVE
  // rewrite walks pages, so the generated relation must land within the measured
  // envelope or the derived CAP_STMT is not a bound on anything.
  let drift = false;
  for (const [t, spec] of [['email_address_state', AS], ['email_delivery_events', DE]]) {
    // heap and index are checked SEPARATELY: a relation can hit the right total
    // with the wrong split, and a rewrite walks the heap while a constraint
    // validation walks indexes too.
    for (const [what, sizeSql, want] of [
      ['heap',  `pg_relation_size('public.${t}')`,        Number(spec.heap_bytes)],
      ['index', `pg_indexes_size('public.${t}')`,         Number(spec.index_bytes)],
      ['total', `pg_total_relation_size('public.${t}')`,  Number(spec.total_bytes)],
    ]) {
      if (!Number.isFinite(want) || want <= 0) {
        console.error(`refusing: ${t}.${what}_bytes must be measured (got ${want})`); process.exit(4);
      }
      const got = Number((await c.query(`SELECT ${sizeSql}::bigint AS v`)).rows[0].v);
      const pct = Math.abs(got - want) / want * 100;
      const ok = pct <= TOL;
      console.log(`BYTES ${t}.${what} generated=${got} measured=${want} drift=${pct.toFixed(1)}% tolerance=${TOL}% ${ok ? 'ok' : 'OUT_OF_TOLERANCE'}`);
      if (!ok) drift = true;
    }
  }
  if (drift) {
    console.error(`FAIL: the generated baseline is outside the measured byte envelope, so a timing
measured on it would not bound production. Adjust the widths/history in the scale
file (or widen byte_tolerance_pct deliberately, and say so in the evidence).`);
    process.exit(6);
  }
  console.log(`SYNTH email_address_state=${n1} email_delivery_events=${n2} elapsed_ms=${Date.now() - t0} all_addresses_synthetic=yes`);
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
} finally { await c.end().catch(() => {}); }
