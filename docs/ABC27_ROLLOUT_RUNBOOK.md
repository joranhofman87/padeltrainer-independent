# ABC-27 / D5 — forward-only rollout and recovery runbook

**STATUS: AUTHORED ONLY. NOTHING HERE HAS BEEN EXECUTED.** No step below has run against any
database, staging or production. Every production step is separately owner-gated; this document
records the order and the checks, not permission to perform them.

The migration has not been applied to any staging or production database. Its test suite and
independent reviews HAVE been run locally, against disposable PostgreSQL instances only — so the
behavioural claims below are locally verified, while every claim about *this* deployment remains a
plan to be carried out. **This checkpoint is not deployment-clear:** the three explicit later gates
below remain owner-controlled prerequisites.

## Explicit later gates (not implemented here)

1. `quiet_hours_respect=true` remains the canonical catalog truth. Instant-send quiet-hours
   enforcement is the separately approved **D7-3** item; this checkpoint neither disables quiet
   hours nor claims that transport enforces them already.
2. The email CTA is deliberately neutral and points to `https://padeltrainer.ai/app/player`.
   A dedicated authenticated round deep link belongs to the later full **U4 route/adapter** work.
3. Guests receive terminal `rebook_member_open_guest_not_actionable`. Guest member-window booking
   needs a separate owner-approved claim/auth/identity design; this checkpoint invents no guest
   login, claim or booking authority.

## What this unit changes outside its own tables

Two **shared** notification surfaces are tightened. Both affect every event, not only
`rebook_member_open_player`, and both are the reason this rollout cannot be treated as additive:

1. `notification_outbox` — `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` revoked from every runtime
   role. All legitimate writers are already `SECURITY DEFINER` (`enqueue_notification`,
   `claim_notification_outbox_batch`, `defer_notification_outbox_row`, the disposal/reconcile
   RPCs), so they are unaffected — but that must be **demonstrated by the full notification suite**,
   not assumed from a grep. The digest worker's direct `select(...)` is why `SELECT` is retained.
2. `notification_event_types` — same revoke, plus an unconditional immutability trigger on the
   rebook event's security-bearing fields.

`enqueue_notification` also gains three parameters (18 total). The old 15-argument form is dropped
so no overload survives; every existing call site is unaffected because the new parameters are
appended and defaulted.

## Preflight (read-only, owner-gated)

1. Confirm no `public.rebook_round%` or `rebook_round_recipient%` object already exists. The
   migration's §0 refuses to adopt one; a hit means the target is not what this was written against.
2. Confirm `notification_outbox.related_rebook_round_id` and
   `related_rebook_round_recipient_id` do not exist, and — the same refusal, on the other relation —
   that neither `cycles.rebook_round_id` nor `cycles.rebook_member_open_materialized_at` exists.
   §0 refuses each of those columns by name, so a target carrying one passes an incomplete preflight
   and then aborts during the install.
3. Inventory current grants on `notification_outbox` and `notification_event_types` and record them
   verbatim — they are what a rollback restores.
4. Count legacy candidates in **both** units, because they are different numbers and only one of
   them is what step 4 of the apply order verifies. The backfill selects candidate **cycles** and
   then groups them by round key — `COALESCE(settings->>'rebook_round_id', cycle id)` — emitting one
   adopted-or-flagged round per group. Two sibling cycles sharing one round UUID are therefore two
   candidate cycles and one round. The queries below mirror the migration's own candidate filter and
   its grouping expression; they are read-only, and both results are recorded.

   **One predicate is deliberately absent, and it has to be.** The migration's candidate filter also
   requires `c.rebook_round_id IS NULL`. That column is created **by this migration**, so on a
   target that has not been migrated yet it does not exist and the query below would fail with
   `42703` — and once it does exist, every row has NULL in it, because nothing has attached a cycle
   to a round. The predicate is there for the backfill's own safety, not to select; omitting it here
   is what makes these counts runnable at preflight time, and it changes none of them. (If a run of
   these queries errors with "column c.rebook_round_id does not exist", the fences have been copied
   from the migration rather than from here.)

   **(4a) Candidate cycles — scale only.** How much the backfill will read; never the number the
   install's NOTICE is compared against.

   ```sql
   SELECT pg_catalog.count(*) AS candidate_cycles
     FROM public.cycles c
    WHERE c.owner_type OPERATOR(pg_catalog.=) 'academy'
      AND pg_catalog.jsonb_typeof(c.settings) OPERATOR(pg_catalog.=) 'object'
      AND (c.settings OPERATOR(pg_catalog.->>) 'rebook_payment_mode') IS NOT NULL;
   ```

   **(4b) Candidate rounds — the verification unit.** This is the number `adopted + flagged` must
   equal. The `~*` test and the `jsonb_typeof(... -> 'rebook_round_id') = 'string'` guard are the
   migration's own: a `rebook_round_id` that is not a well-formed UUID string does not become a
   round key, so such a cycle groups under its own id exactly as the backfill groups it.

   ```sql
   WITH candidate AS (
     SELECT c.id,
            CASE WHEN pg_catalog.jsonb_typeof(c.settings OPERATOR(pg_catalog.->) 'rebook_round_id')
                        OPERATOR(pg_catalog.=) 'string'
                  AND (c.settings OPERATOR(pg_catalog.->>) 'rebook_round_id') OPERATOR(pg_catalog.~*)
                      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                 THEN (c.settings OPERATOR(pg_catalog.->>) 'rebook_round_id')::pg_catalog.uuid
            END AS json_round
       FROM public.cycles c
      WHERE c.owner_type OPERATOR(pg_catalog.=) 'academy'
        AND pg_catalog.jsonb_typeof(c.settings) OPERATOR(pg_catalog.=) 'object'
        AND (c.settings OPERATOR(pg_catalog.->>) 'rebook_payment_mode') IS NOT NULL
   )
   SELECT pg_catalog.count(DISTINCT COALESCE(cd.json_round, cd.id)) AS candidate_rounds
     FROM candidate cd;
   ```

   **(4c) What the backfill will not look at, disclosed rather than left silent.** A cycle whose
   `settings` is not a JSON object is outside the candidate filter entirely: `->>` on a non-object
   returns NULL — measured on a JSON string scalar, and the same by construction for an array, a
   number, a JSON `null` and a SQL NULL, since the operator has no key to look up in any of them —
   so such a row cannot present a
   `rebook_payment_mode`, is not a candidate, and is therefore neither adopted nor flagged. It is
   **not** silently reclassified and nothing about it changes; it is simply invisible in (4a) and
   (4b), so it is counted here so the operator knows the size of what the backfill ignores.

   ```sql
   SELECT pg_catalog.count(*) AS non_object_settings_cycles
     FROM public.cycles c
    WHERE c.owner_type OPERATOR(pg_catalog.=) 'academy'
      AND (pg_catalog.jsonb_typeof(c.settings) IS NULL
           OR pg_catalog.jsonb_typeof(c.settings) OPERATOR(pg_catalog.<>) 'object');
   ```
5. Confirm no active cron job invokes the retired per-cycle notice RPCs.
6. Record the **executor-side expression surface** of the two shared relations this unit writes to,
   `notification_outbox` and `notification_event_types`: every CHECK constraint, column DEFAULT,
   index expression and trigger on them, and confirm each is one the shipped lineage created.

   **Why this is a preflight item and not a curiosity.** An expression the executor evaluates is not
   part of any statement's plan and belongs to no routine's `proconfig`. Measured: a `NOT VALID`
   CHECK whose predicate calls `pg_catalog.set_config` on a timeout GUC is still evaluated for every
   new row, so an ordinary `INSERT` — and this unit does insert into both relations — changes the
   applying session's setting, while a statement recorder sees only the INSERT and a plan reader
   sees nothing at all. The suite's evidence covers this by reading the applying session's own GUC
   values before and after, which catches it after the fact. Confirming the surface here is what
   prevents it beforehand. A drifted target is out of scope for this rollout in any case: preflight
   item 1 exists for the same reason.

## The installation window — what must be quiet, and why

This is the part of the rollout that is easiest to get wrong, because the intuition ("a migration
takes some locks; traffic queues briefly") is wrong here in two specific ways. Both are measured on
the server version this unit targets, and the migration's own comments state the same facts.

**`academy_managers` goes fully offline part-way through, not briefly.** `CREATE`, `ALTER` and
`DROP POLICY` each take `ACCESS EXCLUSIVE` on the relation they name. The composition issues
`ALTER POLICY` on `public.academy_managers`, so from that statement onward this transaction holds
`ACCESS EXCLUSIVE` there — and a relation lock is held until the transaction ends. That relation
therefore excludes **every other session, readers included**, for the whole remainder of the
install, which is most of the file.

The other nine start out carrying only `SHARE ROW EXCLUSIVE` — their readers unaffected, their
writers queued — but `public.cycles` does not stay that way: later schema work takes
`ACCESS EXCLUSIVE` on it too, and on `public.notification_event_types` and
`public.notification_outbox`, which are not in the lock set at all. So `academy_managers` is the
relation that goes offline earliest and for longest, and it is not the only one that goes offline.

**The session that stalls you is invisible when the migration starts.** `ACCESS SHARE` — the lock a
plain `SELECT` takes — does not conflict with `SHARE ROW EXCLUSIVE`. A session already inside a
transaction that merely *read* `academy_managers` will not block the migration's lock acquisition
at all. It blocks later, at the `ALTER POLICY`, when the migration is already holding all ten
locks. Watching the acquisition succeed proves nothing about whether the install will stall.

### Three possible outcomes, not one

Conflicting traffic does not simply "queue". Plan for all three:

| Outcome | What it looks like | What to do |
|---|---|---|
| **Queue** | Traffic waits, install completes. | Nothing. The ordinary case. |
| **Indefinite block** | The install sits waiting and never progresses. Nothing here is timeboxed; an idle-in-transaction holder never yields on its own. | Identify the holder, then **manually abort the install** and retry in a quieter window. Do not kill the holder blindly. |
| **Deadlock** | PostgreSQL aborts one participant — and it may be **this install**, not the application transaction. | Let it abort, then retry. The whole file is one transaction, so an abort leaves nothing behind. |

Aborting is always safe. It is not free, which is why it is planned for rather than discovered.

### What the window must exclude

In addition to the administrative classes the migration already documents — DDL, `GRANT`/`REVOKE`,
role and membership changes, default-privilege changes, cluster-wide ownership changes and direct
catalog DML, with the role/membership/shared-ACL parts scoped cluster-wide — the window must also
quiesce, for `public.academy_managers` specifically:

- **pre-existing** transactions holding any lock on it, *including readers*; and
- **incoming** readers and writers, which will queue from the `ALTER POLICY` until commit or abort.

**And the census covers all twelve relations, not only that one.** `academy_managers` is the
relation that goes offline earliest and for longest, but it is not the only one the install can
stall on: the other nine of the lock set are taken at the same moment, `public.cycles` is later
upgraded to `ACCESS EXCLUSIVE`, and `notification_event_types` and `notification_outbox` are taken
`ACCESS EXCLUSIVE` without being in the lock set at all. A holder on any of them blocks the install
indefinitely, and a census confined to one relation returns nothing while that happens — which is
the worst outcome this section can produce, because the recovery step it feeds says *identify the
holder*. The relation is therefore reported as a column, and the list is the twelve the install
touches. `to_regclass` is used rather than a cast so a relation that does not exist on this target
yields NULL instead of aborting the census.

Verify before applying (read-only), and re-check immediately before step 2:

```sql
SELECT l.relation::pg_catalog.regclass::pg_catalog.text AS relation,
       l.pid,
       l.mode,
       l.granted,
       t.transactionid                    AS transaction,
       px.gid                             AS prepared_gid,
       (px.gid IS NOT NULL)               AS is_prepared,
       a.state,
       a.xact_start,
       pg_catalog.left(a.query, 120)      AS query
  FROM pg_catalog.pg_locks l
  -- HOP 1: from the relation lock to the transaction-id lock of the SAME virtual transaction.
  LEFT JOIN pg_catalog.pg_locks t
         ON t.pid IS NULL
        AND t.locktype OPERATOR(pg_catalog.=) 'transactionid'
        AND t.virtualtransaction OPERATOR(pg_catalog.=) l.virtualtransaction
  -- HOP 2: from that transaction id to the prepared transaction that owns it.
  LEFT JOIN pg_catalog.pg_prepared_xacts px
         ON px.transaction OPERATOR(pg_catalog.=) t.transactionid
  LEFT JOIN pg_catalog.pg_stat_activity a
         ON a.pid OPERATOR(pg_catalog.=) l.pid
 WHERE l.locktype OPERATOR(pg_catalog.=) 'relation'
   AND l.relation OPERATOR(pg_catalog.=) ANY (ARRAY[
         pg_catalog.to_regclass('public.academy_managers'),
         pg_catalog.to_regclass('public.academy_profiles'),
         pg_catalog.to_regclass('public.availability_slots'),
         pg_catalog.to_regclass('public.bookings'),
         pg_catalog.to_regclass('public.cycles'),
         pg_catalog.to_regclass('public.guest_players'),
         pg_catalog.to_regclass('public.locations'),
         pg_catalog.to_regclass('public.profiles'),
         pg_catalog.to_regclass('public.slot_priority_claims'),
         pg_catalog.to_regclass('public.trainer_profiles'),
         pg_catalog.to_regclass('public.notification_event_types'),
         pg_catalog.to_regclass('public.notification_outbox')
       ]::pg_catalog.oid[])
   AND l.database OPERATOR(pg_catalog.=) (SELECT d.oid FROM pg_catalog.pg_database d
                                           WHERE d.datname OPERATOR(pg_catalog.=)
                                                 pg_catalog.current_database())
   AND (l.pid IS NULL OR l.pid OPERATOR(pg_catalog.<>) pg_catalog.pg_backend_pid())
 ORDER BY a.xact_start NULLS FIRST, relation;
```

**Why every name here is schema-qualified — and there are two different interceptions, not one.**
Both are measured on PostgreSQL 18.4 and both are reachable in an ordinary operator session.

- **Relations and types.** The temporary schema is searched before `pg_catalog`, and does not have
  to appear in `search_path` to be searched at all — and it is searched for **relation names and
  type names alike**. That precedence is a property of `pg_temp` being *implicit*: a path that names
  `pg_temp` explicitly searches it in the position it was named in, which is why this unit's own
  probes pin `pg_catalog, public, pg_temp` and put it **last**. An operator session does not
  normally name it, so for that session the temporary schema really does come first.
  `CREATE TEMP TABLE pg_locks (…)` makes a bare `SELECT … FROM pg_locks` read
  the temporary table; `CREATE DOMAIN pg_temp.regclass AS text` makes a bare `::regclass` resolve to
  that domain. Measured: the first answers with fabricated rows, and the second stops the census
  resolving at all (`42883`, no operator `oid = regclass`). Both are removed by qualification.
- **Functions and operators.** The temporary schema is *never* searched for these — that is
  PostgreSQL's rule for the temporary schema and nothing here re-measures it with a `pg_temp.left`
  impostor — but `pg_catalog` is searched first only while it stays
  **implicit**. Naming `pg_catalog` explicitly puts it in the position it was named in, so a session
  whose path is `some_schema, pg_catalog, public` resolves `left(…)`, `<>` and even
  `current_database()` out of `some_schema`. That half **is** measured, in an ordinary named schema
  rather than in `pg_temp`: in such a session `left('abcdef', 3)` returns
  whatever that schema's function returns, and `1 <> 2` is **false**.

An operator session in either state would run this census against an answer it did not compute —
and the two states fail differently, which is worth knowing before trusting one. The relation,
function and operator traps **fabricate**: they return rows and values of the planter's choosing,
silently. The type trap does not answer at all; it fails loudly with `42883`, which is the safe
half of the same hazard. Only the silent one can be acted on by mistake.
Qualifying every name removes both possibilities rather than relying on the session being clean. The
migration defends itself differently and deliberately: it pins `SET LOCAL search_path` as its own
first statement and qualifies the names where interception would matter, which it can do because it
controls its own session. A census pasted into whatever session an operator happens to have cannot
assume either, so it qualifies everything.

**What is deliberately left unqualified, because it cannot be qualified.** `COALESCE` is SQL
*syntax*, not a function: `pg_catalog.coalesce(…)` is an error (`42883`, "function
pg_catalog.coalesce does not exist"), and there is nothing for a schema to intercept. The same is
true of `IS NULL`, `NULLS FIRST` and the `::` cast operator itself — the *type name* after a cast is
resolved through the path and is qualified above, but the cast syntax is not. This rule governs
every fenced query in this document, not only the census: the preflight grouping query below leans
on `COALESCE` for exactly the same reason, and qualifies everything around it.

`IS DISTINCT FROM` is **not** in that category, which is why the pid test above no longer uses it.
It resolves its equality operator through the search path like any other operator, and it cannot be
written with an operator schema — measured, `1 IS DISTINCT FROM 2` is **false** in a session with a
hostile `=` earlier in the path. `l.pid IS NULL OR l.pid OPERATOR(pg_catalog.<>) …` is exactly
equivalent, keeps the NULL-pid rows for the same reason, and can be qualified.

**Why the prepared gid is raw, and why it now has a boolean beside it.** This census used to render
`coalesce(px.gid, '<session>')`, borrowing a gid-shaped string as the sentinel for "no prepared
transaction". A gid is arbitrary text and `PREPARE TRANSACTION '<session>'` is accepted — measured —
so a real prepared holder can be named exactly like the sentinel, and the one row that must never be
mistaken for a live session was the one that read like one. The gid is therefore returned as it is,
`NULL` included, with `is_prepared` answering the question the sentinel was standing in for: a row
with `is_prepared = false` is a live session and its `prepared_gid` is NULL; a row with
`is_prepared = true` is a prepared holder, whatever its gid happens to spell.

**Why the `l.database` predicate is not optional.** `pg_locks` is **cluster-wide**, while a relation
OID identifies a relation only **within one database**. It is not that two databases collide by
chance: the OID counter is cluster-wide and monotonic, so ordinary allocation does not hand a second
database an OID the first is still using. Collisions are **inherited**. `CREATE DATABASE … TEMPLATE`
copies the template's `pg_class` rows verbatim, OIDs included, so every database cloned from the
same template carries the same OID for every relation that template already had — and OID
wraparound can reissue a value besides. Without the predicate the census matches any lock on any
such twin, in another database entirely, on a table that merely inherited the number. That row can
carry a perfectly valid GID, and acting on it would mean committing or rolling back a stranger's
transaction on the strength of an OID this database never uniquely owned. The predicate confines the
census to the database being migrated.

**Why two hops, and not one.** A relation-lock row does not carry a transaction id — its
`transactionid` column is NULL, for every holder, always. Joining `pg_prepared_xacts` directly to
`l.transactionid` therefore matches nothing, and every prepared holder comes back with a NULL
`prepared_gid` and `is_prepared` false — indistinguishable from a live session:
the census still proves there is contention, but it cannot name what is causing it, which is the
one thing the operator needs. The transaction id lives on a *separate* `transactionid` lock row
belonging to the same `virtualtransaction`, and that row is what carries the value
`pg_prepared_xacts` can be joined on. This is the same two-hop path the migration itself uses to
name a prepared holder in its refusal messages; it is reproduced here rather than reinvented.

**Why the joins are `LEFT` and the pid test keeps NULLs explicitly.** A prepared transaction holds
its locks with **no backend at all**, so its `pg_locks` row has a NULL `pid`. An inner join to
`pg_stat_activity`, or a plain `l.pid <> pg_backend_pid()`, drops exactly those rows — and a
prepared holder is the worst case here, because unlike a live session it will never time out, never
disconnect and never yield. `l.pid IS NULL OR l.pid OPERATOR(pg_catalog.<>) …` keeps them, and does
it with an operator no search path can supply.

**Reading the result.** Any row is a potential late stall. An `idle in transaction` row is the
dangerous one. A row whose `is_prepared` is true is worse: nothing will ever clear it on
its own, and it must be resolved deliberately — including when its `prepared_gid` happens to read
`<session>`, which is a legal gid and not a sentinel.

**Resolving a prepared holder — a decision, never an automatic step.** With the gid in hand, inspect
what that transaction was doing before choosing, because committing and rolling back are not
interchangeable and neither is reversible:

**A gid identifies a transaction only for as long as that transaction exists.** `PREPARE
TRANSACTION` refuses a name already in use, so at any one instant a gid is unique — but that is an
instantaneous property, not a stable identity, and the operator's inspection and the operator's
resolution are two different instants. Measured: prepare T1 as `G`, inspect it, let its coordinator
resolve it, and an unrelated T2 can then prepare under the very same `G`. The
`ROLLBACK PREPARED 'G'` that was decided on T1's evidence then resolves **T2**, irreversibly, and
nothing in the command or its output says so.

Nothing inside the database closes that window, so the fence is external, and it has two halves.
Both are required; the second alone only narrows the race.

1. **Quiescence, proved.** Resolve only inside an operator window in which nothing else in this
   cluster can prepare or resolve a prepared transaction: the application, every transaction
   coordinator or transaction manager that could be the other half of a distributed commit, every
   admin or ETL job, and every scheduler are stopped, and that is *proved* the same way the worker
   pause in step 1 of the apply order is proved — not inferred from a config value.
2. **An identity re-check as the immediately preceding statement.** Run the identity query below,
   record the whole row, and run it once more as the statement immediately before
   `COMMIT PREPARED` / `ROLLBACK PREPARED`. Every column must be unchanged — `transaction`,
   `prepared`, `owner` and `database` together, not the gid, which is the one column a stranger can
   reproduce exactly. Any difference, and any empty result, means the transaction that was
   inspected is gone: **stop**, and start again from the census.

These commands are written for **psql**, and `:'gid'` is a psql variable — it is not SQL. It has to
be bound before they run, and **how it is bound matters as much as how it is used**.

**Capture the value from the server; never type it.** `:'gid'` quotes a value that is already in the
variable — it cannot protect a value that was mangled on its way in. A gid is arbitrary text, and
both of the obvious ways to set one by hand are parsed before `:'gid'` ever sees it: a shell
`-v gid='…'` goes through shell quoting first, and `\set gid '…'` through psql's own metacommand
parsing. Neither is safe for a gid containing an apostrophe. `\gset` has no such step — it takes the
value out of a result row:

```sql
\set ON_ERROR_STOP on
\unset gid
SELECT px.gid AS gid
  FROM pg_catalog.pg_prepared_xacts px
 WHERE px.transaction OPERATOR(pg_catalog.=) :'xid'::pg_catalog.xid \gset
```

Bind `:'xid'` — the census's `transaction` column, which it reports for exactly this purpose —
rather than the gid: it is a transaction id, so it is digits, and there is nothing in it to quote.
A row whose `transaction` is NULL is not a prepared holder at all, and `is_prepared` is false beside
it; resolve nothing and investigate, because without an identity there is nothing to re-check
against.

**The two metacommands above the query are the fence, and neither is decoration.** `\gset` assigns
only when the query returns exactly one row. On any other outcome it reports an error and leaves the
variable **exactly as it was** — measured here, on PostgreSQL 18.4 through psql 18.4. The wording
below is psql's **C/English** message text: psql translates its own diagnostics, so under another
locale these read differently. Act on the behaviour and the exit status, never on the message:

| Result | What psql reports | The variable afterwards |
|---|---|---|
| one row | nothing | the captured gid |
| **no rows** | `no rows returned for \gset` | **unchanged — the previous gid** |
| **more than one row** | `more than one row returned for \gset` | **unchanged — the previous gid** |
| one row, NULL value | nothing | *unset* |

The middle two rows are the hazard, and it is not hypothetical. Capture a gid for one transaction,
then look up a second that has already gone: the lookup returns nothing, and the resolution that
follows still has a name to act on — the **first** transaction's — which it rolls back
irreversibly. Measured, on two real prepared transactions.

`\unset gid` closes that. An unset psql variable is not substituted at all: the resolution reaches
the server as the literal characters `:'gid'` and is refused with `42601`, a syntax error, so a
capture that did not happen cannot resolve anything. Measured both ways, in the state this fence is
for — a session that **continues** after the failed `\gset`, i.e. with `ON_ERROR_STOP` off: without
the `\unset` the stale transaction is rolled back, and with it the same sequence leaves both
transactions standing. With the `ON_ERROR_STOP on` above it, a *script* never reaches the
resolution at all — the two metacommands cover different halves, which is why both are here.

`\set ON_ERROR_STOP on` is the other half, and it is the half a *script* needs: it makes psql stop
at the failed `\gset` and exit `3` instead of going on to the resolution below it — measured in
file mode, which is how a script runs. It governs script processing, so by psql's own definition it
does **not** stop an interactive session; that half is not measured here, and it is why the
`\unset` is there as well rather than instead.

**And the cast is what stops a mistyped transaction id from being anything else.** `:'xid'` is
psql's own literal quoter, so a value carrying an apostrophe arrives as one literal — measured,
`755';DROP TABLE …;--` becomes `'755'';DROP TABLE …;--'` — and `::pg_catalog.xid` then refuses it
with `22P02` before it is compared to anything. Write `:'xid'`, never a bare `:xid`: unquoted, that
same value is substituted raw and is an injection. Without the cast the unknown literal still
resolves to `xideq(xid, xid)` rather than to `=(xid, integer)`, so a transaction id above `2^31`
compares correctly — measured — but that is a resolution rule worth knowing, not one worth
depending on.

**There is no "ordinary gid" exception, and this document used to grant one.** It said a hand-typed
literal was acceptable when the gid looked plainly ordinary — letters, digits and underscores — and
it carried two worked examples of binding one by hand. That test cannot be applied by the person who
has to apply it, because the difference that matters is the one that cannot be seen. A gid is
arbitrary text, so trailing whitespace is legal: `G` and `G ` are two different gids and both can be
prepared at once. An operator who reads the blocking holder as `G` binds `G`; the identity re-check
then agrees, twice, *consistently* — on the wrong transaction — and the resolution is irreversible.
Every fence below keys off that same wrong gid, so nothing downstream can catch it. The forms are
named above only to say what not to do; there is no longer a command here to copy.

**The gid is therefore never typed, pasted or transcribed, on any path.** In psql it is captured
from a result row by the `\gset` flow above, keyed on the census's numeric `transaction` column; in
any other client the server renders the command from a row selected by that same numeric id. What
the operator carries is digits, and only digits, on both paths.

```sql
SELECT px.transaction, px.gid, px.prepared, px.owner, px.database
  FROM pg_catalog.pg_prepared_xacts px
 WHERE px.gid OPERATOR(pg_catalog.=) :'gid';
```

**In any other client, do not paste the gid into quotes.** There is no `:'gid'` substitution
outside psql, and hand-quoting is not a substitute for it: a gid is arbitrary text chosen by
whoever prepared the transaction, so it may contain a quote, a semicolon or a comment marker, and
wrapping it in apostrophes then produces either a different literal or — in a client that sends
multi-statement simple queries — a second statement of the pasted text's own choosing. Measured, on
a prepared transaction whose gid is `abc'; DROP TABLE public.y; --`, hand-quoting it into the
lookup above drops that table.

**And parameter binding is not the whole answer either, because the gid still has to reach the
client intact.** Binding removes the injection; it cannot undo a value that was already altered
on its way to you. A gid is arbitrary text, so trailing whitespace is legal and invisible: `G`
and `G ` are two different gids that can be prepared at the same time, and a console, ticket or
spreadsheet that trims the copied value hands you `G` for a transaction actually named `G `. The
binding is then perfectly safe and perfectly wrong — it selects the *other* transaction, the
identity you record is that other transaction's, and the command you are handed resolves it,
irreversibly.

So this path keys on the same thing the psql path does — the census's `transaction` column, which
is digits — and never asks the operator to carry the gid at all. The gid stays server-side from
the census to the rendered command:

```sql
SELECT px.transaction, px.gid, px.prepared, px.owner, px.database,
       pg_catalog.format('COMMIT PREPARED %L',   px.gid) AS commit_command,
       pg_catalog.format('ROLLBACK PREPARED %L', px.gid) AS rollback_command
  FROM pg_catalog.pg_prepared_xacts px
 WHERE px.transaction OPERATOR(pg_catalog.=) $1::pg_catalog.xid;
```

Bind the census's `transaction` value to `$1` through the client's parameter API — never by
string-building the query. It is digits, so nothing about it can be mangled by quoting, trimming or
re-encoding, and `::pg_catalog.xid` refuses anything that is not one. This single row is both the
identity to record and the command to run: check `database` and `owner` on it, re-read it
immediately before resolving, and execute the returned text **verbatim, as one statement**. `%L` is
PostgreSQL's own literal quoter, so a gid containing `'`, `;` or `--` round-trips exactly —
measured, on that same gid — and the operator never handles it.

**A gid is unique cluster-wide** at any one instant — `PREPARE TRANSACTION` refuses a name already
in use — so at that instant it names one transaction and one only. That is *not* the same as it belonging to the database you are
migrating: `pg_prepared_xacts` lists every database's prepared transactions, which is why the row's
`database` column has to be checked, and why the census above is confined to the current database
before a gid ever reaches this step. Nor is it the same as being a durable name for one transaction,
which is what the quiescence window and the identity re-check exist for.

**That query does not tell you which way to resolve it, and nothing in the database will.** It
returns who prepared it, when, and in which database — metadata, not intent. A prepared transaction
is one half of a distributed commit: the authority for whether it should commit or roll back lives
in whatever coordinated it, which is the application, the transaction manager, or the change record
that created it. Confirm the `database` column matches the database you are migrating, then obtain
that authority before choosing.

**And check the `owner` column against the role you are connected as.** `COMMIT PREPARED` and
`ROLLBACK PREPARED` may be issued only by the role that prepared the transaction or by a superuser;
any other role is refused with `42501`, *after* it has passed every identity check above. If the
owner is not you and you are not a superuser, this is not your resolution to perform.

Then, as a deliberate operator decision, and with the identity re-check as the statement
immediately before it, either `COMMIT PREPARED :'gid'` or
`ROLLBACK PREPARED :'gid'`. Both must run **outside a transaction block**: inside one PostgreSQL
refuses them with `25001` — measured — so do not wrap them in `BEGIN`/`COMMIT`, and do not issue
them through a client or tool that opens a transaction on your behalf. Re-run the census afterwards
and confirm the row is gone before starting
the install; an empty census is the verification, not the assumption.

**Two states in which to stop rather than proceed:**

- The census shows contention but no GID can be identified — no row has `is_prepared` true and no
  session is visible in `pg_stat_activity`. Investigate; do **not** guess.
- A GID is identified but its correct disposition cannot be established from an authoritative
  source. Neither outcome is reversible and neither is a safe default: committing may publish work
  that was meant to be discarded, and rolling back may discard work that was meant to be published.
  Waiting is the only safe move, and the migration simply does not run until it is resolved.

There is no automatic recovery here and none should be added. Nothing in this section probes or
mutates production on its own; each statement is one an operator runs, reads, and decides on.

**Do not "fix" this with a lock timeout, a retry loop or a weaker lock.** What closes the gap
between the migration's checks and the statements they protect is the `SHARE ROW EXCLUSIVE` set
taken *before* those checks — that is the serialization, and it would be unchanged even if policy
DDL took a lesser lock. The `ACCESS EXCLUSIVE` upgrade is a consequence of using `ALTER POLICY`, not
the mechanism: what it adds is reader exclusion, which is the availability cost described above and
not a guarantee to be traded away. Weakening either one removes protection without removing the
cost. The window is the mechanism, and manual abort/retry is the recovery.

## Apply order

### Executor contract — "one transaction" is the executor's job, not the file's

**This is a prerequisite, not a description of what will happen.** The migration is written to be
applied as ONE explicit `READ COMMITTED`, read-write transaction, by one session, whole file, and it
says so itself. Its re-verification block dispatches on two facts that exist only inside the
applying transaction — the serialization lock on `pg_catalog.pg_policy`, or an `ON COMMIT DROP`
temporary relation — and when neither holds it refuses with *"this file must be applied as ONE
transaction"*, a HINT ending *"Apply the whole file in a single READ COMMITTED transaction as that
role"*, and the explicit statement that **whole-file atomicity is the declared deploying role's
contract, verified by the deployment runbook**. This section is that verification.

The file cannot enforce it, and the refusal is not a safety net: by the time it fires, an autocommit
or chunking executor has already **committed** everything before it. Measured on a clone of the
shipped predecessor — the identical statement sequence, differing only in the transaction envelope:

| Executor | Outcome | What it left behind |
|---|---|---|
| Statement-by-statement, autocommit | refused at the re-verification dispatch | §0b's schema grants, **committed** |
| The same statements in one explicit `READ COMMITTED` transaction | installed | nothing, once rolled back |

That is one measured autocommit shape, not a general prediction: another autocommit session can
refuse **earlier** — the file's first statement is a `SET LOCAL`, which outside a transaction block
does nothing but emit a warning, so a session whose `search_path` differs can fail the envelope
guard before §0b runs and leave nothing at all. What the pair establishes is the point of this
section: whether anything is left behind depends on the executor, and the file's refusal is not a
safety net that undoes what preceded it.

**Bind the checks and the apply to one connection, explicitly.** Everything below must use the same
connection string, and `-X` on both invocations so a `.psqlrc` cannot reconnect elsewhere or
override `ON_ERROR_STOP`:

```
export ABC27_TARGET='postgresql://<deploying-role>@<host>:<port>/<database>'
```

First, confirm the file is the reviewed one — the runbook is not a substitute for the digest:

```
shasum -a 256 supabase/migrations/20261118120000_abc27_rebook_round_notification_authority.sql
# must print 05e04451f944cabfaaa74842cacf6e7b0299afc366b443d9609908136e86d78f
```

Then confirm the session that will apply it — role, database and defaults, on that connection:

```sql
SELECT CURRENT_USER                  AS applying_role,
       pg_catalog.current_database() AS applying_database,
       pg_catalog.current_setting('default_transaction_isolation') AS isolation,
       pg_catalog.current_setting('default_transaction_read_only') AS read_only;
```

(`CURRENT_USER` is bare for the same reason `COALESCE` is: it is SQL syntax, not a function, and
`pg_catalog.current_user` is an error. `current_database()` and `current_setting()` are functions and
are qualified.)

The role and database must be the declared deploying ones, and the last two must read
`read committed` and `off`. `REPEATABLE READ` and `SERIALIZABLE` are refused by the migration's own
envelope with `55000`, and a read-only transaction is refused there too — but that is a backstop,
not the mechanism: it can only speak for the connection it runs on, never for how the file was cut
up before it got there, which is why the check is bound to the same connection string as the apply.

Then apply the whole file as one transaction, with no per-statement wrapper of any kind:

```
psql -X -d "$ABC27_TARGET" --single-transaction --set=ON_ERROR_STOP=1 \
     -f supabase/migrations/20261118120000_abc27_rebook_round_notification_authority.sql
```

**Forbidden, in the exact shapes deployment tooling produces them:** splitting the file on
semicolons and sending the pieces; any runner that commits per statement or per batch; any
intermediate `COMMIT`; changing connection part-way; and any wrapper that retries individual
statements — that is, any wrapper that turns one statement into its own unit of failure or of
commit. A `SAVEPOINT` is none of those: it is not a second transaction, it commits nothing, and it
retries nothing. Both savepoint shapes — the whole file inside one, and every statement inside its
own inside a single transaction — install; that is measured, not assumed. If the executor at hand
cannot guarantee the contract above, it is the wrong executor for this file.

1. **Pause** the notification workers, any rebook cron, **and every entrypoint that can create or
   extend a legacy rebook round** — `bulk-rebook-cycle` above all. Prove they are paused and
   drained; do not infer it. Then establish the installation window above and prove
   `academy_managers` is quiet — readers included — with the query in that section. Record the
   result.

   **Why the producer, and not only the workers.** The backfill is one-shot: it adopts the legacy
   cycles that exist when it runs, and never runs again. `bulk-rebook-cycle` writes its round
   identity into `settings` JSON (`rebook_payment_mode`, `rebook_round_id`) and does not set the
   typed `cycles.rebook_round_id` column — and the shipped guard deliberately permits an unattached
   insert, because the normalized apply path is what attaches a cycle to a round. So a legacy round
   created **after** the backfill has run is a round that no backfill will ever adopt and no typed
   materialization will ever see. It is not caught by step 4 either: preflight and the install
   NOTICE were both taken before it existed, so they still agree and the check still reports
   success.

   A request already in flight is enough: it queues behind the migration's locks and commits after
   the migration commits. **Keep these entrypoints paused until step 5** — the canonical command
   driver — is deployed, because that is the first moment a new round can be created in the typed
   model. This is the one step in this document where "paused" must include "and drained".
2. Apply `20261118120000_abc27_rebook_round_notification_authority.sql` **under the executor
   contract above**. It is one transaction only because the executor makes it one: the install
   assertions in §10c either pass or the whole migration rolls back. If it stalls, treat it
   as the indefinite-block row of the table above: find the holder, abort, retry — do not wait it
   out indefinitely and do not weaken the migration.
3. Read the `NOTICE` output. Expect the backfill line
   (`N round(s) adopted with import provenance, M flagged legacy_review_required`) and the
   assertions-passed line. A `BYPASSRLS` notice for `service_role` is **expected on Supabase**.
4. Verify counts **in round units**: `adopted + flagged` equals the preflight **(4b)** candidate
   *round* count. It does **not** equal the (4a) candidate *cycle* count, and equating the two is a
   false check — the backfill emits one adopted-or-flagged round per round key, so two sibling
   cycles sharing one `rebook_round_id` are two cycles and one notice unit. (4a) is scale; (4b) is
   the equality. A difference between (4a) and (4b) means some round key is shared by more than one
   cycle. Usually that is siblings and is expected — but not always: two cycles of **different
   academies** carrying the same valid round UUID also count as one round, and the backfill flags
   that group `legacy_review_required` rather than adopting it. So a difference is a prompt to look
   at which cycles share the key, not a result to wave through; the flagged count in step 3 and
   `rebook_round_legacy_review_summary()` in step 6 are where it shows up.
5. Deploy the canonical command driver and the materializer caller. Do **not** enable any schedule.
6. Verify, read-only: zero direct-send reachability, the exact function ACLs, and that
   `rebook_round_legacy_review_summary()` returns the expected flagged set.
7. Only then, and only under a separate owner gate, resume a canary and observe.

## What the backfill will and will not adopt

Automatic adoption requires **affirmative proof of non-delivery**, which here means the group's
priority window has not yet ended — the old notifier could only fire once the member window opened.
The *absence* of `rebook_member_open_notified_at` proves nothing: that marker was written by the
code whose crashes, rate limits and 20-candidate truncation this unit exists to remove, so a missing
marker is equally consistent with "sent and never recorded".

Every other **candidate** becomes durable `legacy_review_required`: a `rebook_round_id` that is
present but not a well-formed UUID, scalar JSON where an array was expected, a round UUID shared
across academies, disagreeing labels or window boundaries, an old notified marker, a **non-empty or
malformed** recipient array, no slots to derive a window from,
over any bound, or a member window that has already opened. A flagged round gets **no import
receipt**, so it is excluded from materialization by the absence of provenance as well as by its
lifecycle — two independent exclusions.

Two exclusions from that list are worth stating outright, because both were previously described the
other way round:

- An **existing empty** `rebook_member_open_notified_recipients` array is not evidence of anything
  and does not flag. The condition is a recipient array that is non-empty or of an unreadable
  shape; an empty array is accepted and such a round is adopted like any other.
- A **non-object `settings`** does not become `legacy_review_required` either, for a different
  reason: it is not a candidate at all. The candidate filter requires `jsonb_typeof(settings) =
  'object'` and reads `rebook_payment_mode` out of it, and `->>` on a non-object is NULL, so such a
  cycle is never selected and is neither adopted nor flagged. It is counted by preflight (4c) and
  then ignored — untouched, unreclassified, and not hidden.

Nothing is sent, cleared, repaired or deleted. Grouping is never inferred from a name, email, date
or any other mutable field.

## Recovery

- **Install fails at an assertion.** The whole migration rolls back. Fix the cause; do not re-run
  over a partial apply, and do not weaken the assertion to get past it.
- **Install stalls with no error.** See the installation-window section. The likely cause is a
  session holding a lock on `public.academy_managers` — very often a *reader* inside an open
  transaction, which did not block the migration's lock acquisition and so was invisible until the
  `ALTER POLICY`. Identify it with the query there, then abort the install and retry once the
  relation is quiet. Nothing is left behind by the abort.
- **Install aborts with a deadlock (`40P01`).** Expected under conflicting traffic; PostgreSQL may
  choose this install as the victim. Retry in a quieter window. No cleanup is needed.
- **A round refuses to freeze.** Outcome `freeze_refused` with a `WARNING` naming the cause: wrong
  lifecycle, missing origin receipt, a sibling not in `open`, an unreadable claim status, missing
  provenance, or a bound breach. The round stays `pending` with **no** snapshot rows — the freeze is
  one transaction. Resolve the named cause; there is nothing to clean up.
- **A round is stuck `materializing`.** That is normal for a large round: it resumes on the next
  scan and is always selected before pending work, **including after its member window has closed**,
  in which case its remaining recipients receive terminal `member_window_closed` decisions. A round
  is never stranded by an expired window.
- **A recipient looks wrong.** The snapshot is append-only by design. There is no correction path,
  because a changed universe is a different round. Investigate through the provenance rows.

## Not covered here, and deliberately so

Retention and erasure of snapshot and provenance rows is a **separate U2-composed, owner-reviewed
lifecycle command**. This unit retains identifiers only and invents no scrub path. Round, sibling
and decision deletion all fail closed.

The later D7-3 quiet-hours enforcement, full-U4 authenticated round route/adapter, and an
owner-approved guest claim/auth/identity design are also deployment gates. The frozen neutral CTA
and terminal guest decision in this checkpoint do not silently substitute for any of them.

---

# D7 runtime cutover — the composed apply order, the workers, and the two activation gates

Everything above describes installing the ABC-27 authority migration. This section describes the
runtime that drives it, and the two migrations that ship on either side of it. It is **appended**
rather than woven in: the sections above are prose-pinned by the evidence suite, and rewriting them
would be editing the record of what was reviewed.

## The apply order is enforced by the filenames, not by this document

Fifteen files, and they apply in exactly this order because that is what their versions say —
though `supabase db push` is NOT the executor for all of them; see the sequence below.

| Version | File | What it does |
|---|---|---|
| `20261118115000` | `d7_runtime_crons.sql` | Unschedules `notify-rebook-member-open`; installs three D7 jobs **INACTIVE** |
| `20261118115500` | `d7c_cross_owner_contention_closure.sql` | Stage 7.4-C's cross-owner contention closure. **It must precede ABC-27**, which pins the body it installs — omitting it aborts ABC-27's preflight |
| `20261118120000` | `abc27_rebook_round_notification_authority.sql` | The frozen authority migration (above) |
| `20261203110000` | `d7_retire_member_open_surfaces.sql` | The claim index, then the four §10a shim drops |
| `20261203120000` | `d7_paid_group_hold_safety.sql` | Re-issues the live-eligibility authority so a PAID rebook group holds its court in every payment mode |
| `20261203130000` | `d7_dispatch_linearization.sql` | Re-issues `begin_dispatch` so live eligibility is re-read inside the durable authorization transaction — the linearization point |
| `20261203140000` | `d7_paid_group_hold_booking_anchored.sql` | Re-issues the eligibility authority so the paid-group hold is read from the BOOKING, surviving guest-merge claim deletion |
| `20261203150000` | `d7_dispatch_after_cutoff_reason.sql` | A cutoff crossed during the eligibility re-read reports `after_cutoff`, not `window_invalid` |
| `20261203160000` | `d7_runtime_guard_hardening.sql` | Validates each cron job's stored COMMAND, and the claim index's exact definition and predicate |
| `20261203180000` | `d7_cohort_selection_authority.sql` | ONE clusterer, two candidate modes, the legacy naming chain, and the Domain-P bridges behind them |
| `20261203190000` | `d7_selection_actor_surface.sql` | The one actor-authorized selection preview, with closed `selection_mode` and `projection` vocabularies |
| `20261203200000` | `d7_human_child_names.sql` | Re-issues BOTH normalized cores so a child cycle carries the legacy human name instead of a uuid-bearing one |
| `20261203210000` | `d7_selection_apply_surface.sql` | The apply mirror, so the browser never has to hold a source slot array to create a round |
| `20261203220000` | `d7_naming_persisted_form.sql` | Re-issues the naming chain so collisions are decided on the form that is actually stored, with a suffix-aware tier 4 |
| `20261203230000` | `d7_selection_semantics_closure.sql` | Re-issues the digest and BOTH selection surfaces: one boundary label normalization, a typed zero-occurrence refusal, the round version for `extend`, and the contact snapshot |
| `20261203240000` | `d7_protected_event_vocabulary.sql` | The protected event set, and every generic email/WhatsApp/kill-release claimer exclusion, in ONE file so no sender deploy order can open a window |
| `20261203250000` | `d7_invite_recipient_bridges.sql` | The Domain-P read bridges an invitation's recipient and claims are resolved through |
| `20261203260000` | `d7_transport_subject_model.sql` | ONE closed subject triple across both authority tables, the invitation's FK-free subject column, and the two vocabularies |
| `20261203270000` | `d7_transport_subject_authority.sql` | Re-issues every routine that touches a grant so the transport issues and consumes on that triple |
| `20261203280000` | `d7_outbox_guard_subject_split.sql` | Splits the unconditional outbox guard so its transport invariants apply to every protected subject, not just member-open |
| `20261203290000` | `d7_protected_invite_enqueue.sql` | The one branch that can put an invitation into the transport, through the entrypoint that already existed |
| `20261203300000` | `d7_tier4_future_base.sql` | Tier 4 stops generating a suffix that collides with a FUTURE tier-3 name |

**Why the cron retirement has to be first.** The legacy job's first call is
`rebook_cycles_needing_member_open_notice()`, and the ABC-27 migration revokes that function's
EXECUTE from `service_role`. A job still armed when ABC-27 lands would raise `42501` on every tick —
a 500 and an operator page every fifteen minutes, forever. Encoding "retire the cron first" as a
version that sorts earlier means an operator cannot get the order wrong and no step here has to be
remembered.

**Why the schema half has to follow ABC-27.** The four functions it drops are *re-created* by
ABC-27 §10a, which kept their signatures alive so a not-yet-redeployed Edge build would still
resolve. Dropping them earlier would simply see them come back.

**Why the paid-group closure has to follow ABC-27 too.** It REPLACES an ABC-27-owned function body,
which cannot exist until ABC-27 has installed it. Note that these are "after", never "last": the
composed lineage is expected to grow behind them, and nothing in the evidence depends on tail
position.

`src/test/d7ForwardChain.realpg.test.ts` proves this from the directory rather than from this table:
it asserts every migration version in the composed lineage is unique, that the fifteen files sit in
this relative order, that every post-ABC-27 migration carries its prerequisite guard, and then
replays the whole directory in filename order and measures the schema that results.

## Deploy sequence

> **THIS SEQUENCE IS THE APPLY ORDER ONLY. It does not replace §"Apply order" above, and the two
> must be read together.** Two requirements from that section survive unchanged and are repeated
> here because review round 3 found this list contradicting both of them:
>
> - **The producer stays paused and drained** from before the ABC-27 apply until the typed driver is
>   deployed. The backfill is one-shot; a legacy round created after it runs is adopted by nothing
>   and seen by no typed materialization. The cutover does not change that — it moves the moment the
>   pause can END, from "the command driver is deployed" to "step 2 below has shipped".
> - **ABC-27 itself is applied under the executor contract** (`psql -X --single-transaction`, one
>   connection, digest confirmed). `supabase db push` is NOT that executor. If ABC-27 is applied by
>   hand, its row must be recorded in `supabase_migrations.schema_migrations` before any push, or
>   the push re-runs a 20,633-line migration whose install assertions will stop it.
>
> **THE ORDER CHANGED WITH THE WIZARD CUTOVER, AND GETTING IT WRONG BREAKS REBOOKING.** Until this
> release the browser was deliberately still on the legacy producer, so the frontend could merge
> first and wait. It is not any more: both wizards now call
> `rebook_round_selection_preview_as_actor` and `rebook_round_selection_apply_as_actor`, and merging
> them before the migrations land leaves every academy unable to create a round. **The migrations go
> first** — the project's standing fail-closed rule, and this release is exactly the case it exists
> for.

1. **Apply the migrations, in filename order — and note that ABC-27 is NOT the first of them.**
   `20261118115000` (the cron retirement) and `20261118115500` (the cross-owner contention closure)
   both sort BEFORE it and both must already be applied: the first because ABC-27 revokes the RPC
   its cron calls, the second because ABC-27 pins the body it installs and its preflight aborts
   without it.

   **`supabase db push` CANNOT BE ASKED TO STOP AT A VERSION.** It has no target, cutoff or
   "up to" flag — `--include-all`, `--include-roles`, `--include-seed`, `--dry-run` and the
   connection flags are the whole surface — so it attempts EVERY migration missing from the remote
   history table. Issued first, it would run ABC-27 itself, under exactly the executor this
   document forbids, and then continue into the files that depend on it. The three leading files
   are therefore applied by hand, each recorded as it lands, and only the remainder is pushed:

   ```bash
   psql -X --single-transaction "$DB_URL" -f supabase/migrations/20261118115000_d7_runtime_crons.sql
   psql -X --single-transaction "$DB_URL" \
     -c "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261118115000')"
   ```

   Then `20261118115500` the same way, recording `'20261118115500'`. Then ABC-27 itself under the
   executor contract of §"Apply order" — one connection, digest confirmed — recording
   `'20261118120000'` only once it has committed. A version recorded for a migration that did not
   commit is worse than one never recorded: the next push skips it silently.

   With those three in the history table, `supabase db push --dry-run` must list exactly the twelve
   remaining files and nothing else. **Read that list before pushing.** If ABC-27 appears in it, its
   version was not recorded and pushing would re-run a 20,633-line migration whose install
   assertions will stop it part-way.

   Nothing is armed by any of this: every new routine is inert until something calls it, and
   nothing does yet. **The legacy producer is still paused at this point.**
2. **Merge the code.** Workers, the browser command driver and contract, the retirements, the
   registries, the cut-over wizards and these docs. The RPCs they call now exist.
3. **Undeploy `bulk-rebook-cycle`, and only then lift the pause.**

   **The pause is not lifted by merging.** Merging stops the CURRENT frontend from calling the
   producer; it does nothing about a browser tab loaded an hour earlier, which still holds the old
   bundle and can still POST. That endpoint writes cycles, slots and claims directly, and a legacy
   round created after the one-shot backfill is adopted by nothing and seen by no typed
   materialization — exactly the orphan §"Apply order" step 1 exists to prevent. Undeploying it is
   what makes the pause permanent, and it is safe the moment step 2 has shipped because nothing in
   the new bundle calls it.
4. **Undeploy `notify-rebook-member-open`.** Its cron was unscheduled by `20261118115000` back in
   step 1, so nothing is calling it on a schedule by now; undeploying closes the endpoint itself,
   which anything holding its URL would otherwise still reach. Any straggler gets a 404 — a legible
   signal, not a 500 loop.

   (An earlier draft of this step said the cron was "still armed at this point". It is not, and the
   verification in step 6 requires that it is not.)
5. **Deploy the three new edge functions**, with `REBOOK_MEMBER_OPEN_SEND_ENABLED` **not set**:
   `rebook-member-open-worker`, `rebook-round-materializer`, `rebook-member-open-janitor`.
   An invocation of the dispatcher now returns `200 {"status":"disabled"}` having made **zero**
   database calls.
6. **Verify the schedules are inert** before anything else:
   ```
   SELECT jobname, schedule, active FROM cron.job
    WHERE jobname IN ('rebook-member-open-worker','rebook-round-materializer','rebook-member-open-janitor');
   ```
   All three must read `active = false`. `notify-rebook-member-open` must be absent, and
   `auto-rebook-reminder` — scheduled by the same historical DO block — must still be present and
   armed.
7. **Regenerate `src/integrations/supabase/types.ts`** and confirm `npm run db:types:check` is clean.
   This is deliberately AFTER the migrations: the committed types describe the schema production
   has, and regenerating before the apply would make them describe a schema that exists nowhere.
   ```bash
   npx supabase gen types typescript --local > src/integrations/supabase/types.ts
   ```
8. **Stop.** Arming a schedule and setting the send flag are separate owner gates.

## The selection authority — `20261203180000` … `20261203210000`

### Why anything had to be built at all

`rebook_round_preview_command_as_actor` takes `p_source_slot_ids` and `p_child_cycle_ids`, refuses an
empty source array, and pairs the two POSITIONALLY. It does not derive sources from a selection. The
legacy producer did — twice, once per wizard — and the owner's rule is that the browser must not.

### One clusterer, two candidate modes

The only genuine difference between the two wizards is which CANDIDATE slots they start from, so
that is the only thing that differs here.

| Mode | Candidates |
|---|---|
| `source_cycle` | Every slot whose `cyclus_id` is the source cycle, re-anchored to the academy. No term window, no status filter; every series qualifies. |
| `cohort` | The academy's slots at the chosen locations with `start_time` in `[termEnd − 200 days, termEnd]`, where `termEnd` is `<date>T23:59:59.999Z`. A series qualifies when its LAST session falls in the term-end week. |

Everything after that is shared: clustering, extend suppression, exclusion by key, deterministic
ordering, child identity. Two derivations of "which slots does this selection mean" would be two
selection authorities whatever their comments said.

### The cluster identity is academy-local, and that fixed a live defect

`DST_GROUPING=USE_ACADEMY_LOCAL_WEEKDAY_AND_LOCAL_TIME_AS_THE_CANONICAL_CLUSTER_IDENTITY_ACROSS_DST`.

The legacy Edge function clustered on UTC weekday + UTC HH:MM and conceded the consequence in its own
comment: *"a DST change mid-term could split a series; minor"*. It is not minor once ABC-27 is
underneath. A Tuesday 19:00 class running September to December is 17:00Z before the October change
and 18:00Z after it — two series under a UTC key. ABC-27 derives each child's stored `series_key` and
`target_name` from the academy-LOCAL weekday and time, so those two children would have carried
**identical** identities and the typed core refuses that. One ordinary autumn cyclus would have made
the whole preview unusable. `DST: one local recurring series stays ONE series` measures both halves:
the legacy key really does split the fixture, and the local identity really does keep it whole.

### Child identities are derived, not minted

`md5(round_id || '|' || series_key)`. The browser cannot mint one per series because it does not know
the series — so ABC-27's `IDENTITY=CLIENT_MINTED_…_CHILD_…_ONLY` is departed from for the child half
only, narrowly and deliberately. The round uuid is still the client's, so children stay unique across
rounds; the derivation is stable, so the same selection previews and applies to the same identities
and the reviewed fingerprint survives the round trip.

### `counts` and `review` are different questions

- **`counts`** serves the cohort wizard's auto-count, which fires on locations and dates alone. The
  typed core refuses exactly that shape — NULL round id, NULL label, `num_nonnulls(end, weeks) <> 1` —
  so a design that answered it from the core would return `invalid_request` forever. `counts` does
  not call the core, returns no fingerprint, and says `counted`. It cannot arm a send because there
  is nothing to send with.
- **`review`** calls the core in the same statement sequence as the derivation and returns the
  verdict, the fingerprint and the projection together. That co-derivation IS the binding.

### The selection digest

Exclusion intent is a set of server-issued series keys. A key from an earlier answer could name a
different series after the source moved, so every answer carries a `selection_digest` over the
ordered (series_key, slot_id) set **before** exclusion. Echo a stale one and you get
`selection_moved`, never a quietly different round. The digest is **optional on preview and mandatory
on apply**: asking is not acting.

This is what keeps the intent an ARGUMENT rather than a row — no new table, and no window in which
the server believes a selection the operator has not seen.

### Privacy

The roster arm returns a display name and a BOOLEAN — never an address — to a manager of that
academy, which is exactly what the legacy dry run already returned to the same actor.
`d7_p_subject_display` takes **slots**, not person ids, so the tenant boundary is a join rather than a
promise: `guest_players` has no academy column, and a bridge that accepted a guest id list would have
been trusting its caller for containment. No argument to the surface names a person.

Every `d7_p_*` bridge is granted to the Domain-A owner and to no client role, so there is no
reachable derivation API. The forward chain asserts that matrix rather than the migration claiming it.

### Human child names — `20261203200000`

ABC-27 renders a child's `target_name` as `<label> · HH24:MI:SS.US · <weekday> · <location uuid> ·
<trainer uuid>`, and that string reaches `public.cycles.name`. It is unique by construction, which is
what it was for; it is also what an operator and every player of that group would read. The legacy
chain is restored: `Volgende ronde 2026` verbatim for a single series, else `… — Wo 09:00` escalating
through the trainer's first name, the location, and a number that skips what the round already holds.

**It is changed in BOTH normalized cores and nowhere else.** The name is canonicalized into the
reviewed pre-image, so ABC-27's own rule applies — *"leaving them out of the pre-image would let an
apply write names the review never saw"*. Changing the apply bridge alone would have written a name
the fingerprint never covered; changing one core alone would have made every apply drift.

**The rewrite is a transformation, not a transcription.** The two cores are ~840 and ~1,400 lines;
copying them into a migration to change one expression would put every other line at the mercy of a
copy. So the bodies are taken from `pg_get_functiondef`, transformed by two EXACT substitutions each,
and re-issued — everything else byte-identical by construction. Each substitution asserts its anchor
occurs exactly once beforehand and asserts the result afterwards; a core that does not carry the
reviewed rendering aborts the migration instead of being patched approximately.

**Concurrency is fail-closed.** The chain reads the names the round and the target start date already
hold. If another round takes one between review and apply, the fingerprint differs and the operator
gets the typed `source_drift` refusal with nothing written. `uniq_rebook_cycle_key` stays the backstop.

### Caps stay loud

`CAPS=RETAIN_TYPED_200_SUBJECT_AND_8000_SOURCE_LIMITS_WITH_LOUD_TYPED_REFUSALS_NEVER_SILENT_TRUNCATION`.
The typed ceilings are unchanged and unchanged deliberately: `rebook_round_max_cohort_per_child()` =
200, `rebook_round_max_source_rows()` = 8,000. **The legacy path had no ceilings and may have had a
silent one** — the cohort slot fetch carries no `.limit()`/`.range()`, and no `[api] max_rows` appears
in `supabase/config.toml`, so whatever the hosted project's Max Rows setting is was silently
truncating large cohorts. That truncation is deliberately NOT reproduced. A selection over the
ceiling is refused in the typed vocabulary, which an operator can see and act on.

### Evidence, and the mutants that make it evidence

`src/test/d7RuntimeContract.realpg.test.ts` carries E-15 (the derivation), E-16 (the surface), E-17
(the naming chain) and E-18 (selection → review → apply end to end). Parity is measured against a
port of the shipped algorithm whose source lines are pinned, and — because the surface deliberately
never returns a slot array — the parity comparison calls the Domain-P clusterer directly, which the
suite can do as the database owner and no client role can do at all.

Ten mutants, each recorded with the assertion that caught it:

| # | Mutation | Caught by |
|---|---|---|
| N1 | The cluster identity goes back to UTC | `the academy-local identity keeps it as ONE series` |
| N2 | Cohort mode stops testing the term-end week | `COHORT MODE keeps only series whose LAST session lands in the term-end week` |
| N3 | The 200-day lookback becomes 400 | `a slot 201 days before it is not` |
| N4 | Cyclus candidates stop re-anchoring to the academy | `the foreign slot is not a candidate` |
| N5 | The wrapper's membership gate is removed | `a refusal is exactly one row` |
| N6 | The digest becomes blind to which slots a series holds | `a selection the operator has not seen is refused, not silently used` |
| N7 | The apply surface makes the digest optional | `expected 'selection_moved' to be 'refused'` |
| N8 | Tier 0 stops keeping the round name verbatim | `TIER 0 — a single series … keeps the round name VERBATIM` |
| N9 | The human-name rewrite never runs | the migration's own post-condition: `still carries its previous body after the rewrite` |
| N10 | Tier 4 stops skipping taken suffixes | `TIER 4 skips suffixes the round already occupies` |

A first attempt at N6 **did not discriminate** and is recorded because it says something: replacing
`series_key || '>' || slot_id` with `series_key || '>'` still aggregates one element per slot, so the
digest still moved. Only aggregating `DISTINCT series_key` actually made it blind, and that is the
mutant in the table. A battery that reports only its successes hides the difference between a sensor
and a lucky one.

### `20261203170000` was folded away rather than superseded

An earlier file in this batch derived sources for the source-cycle wizard only. Its whole effect
would have been undone by `20261203180000`, and a create-then-drop pair in the permanent lineage is
noise every future reader has to decode. The supersede-never-amend rule protects migrations that may
already have RUN somewhere; that one ran nowhere — never committed, never pushed, never applied
outside this worktree — so it is removed and its one durable finding, the DST collision, is carried
forward in full.

## The wizards are cut over

Both wizards now reach the database through one shared boundary and nothing else. `bulk-rebook-cycle`
is not invoked from anywhere in the browser's path to a round, and there is no fallback: a second
producer would be a second idea of what the operator selected.

### The three hops, and why there are three

| Hop | Call | Why |
|---|---|---|
| Count | `preview(…, 'counts')` | Locations and dates alone. The typed core refuses that shape three ways (no round id, no label, no length), so the counting projection answers it from the derivation and returns NO fingerprint. It cannot arm a send because there is nothing to send with. |
| Review | `preview(…, 'review')` = probe → mint → review | The caller mints one identity per generated slot and only the server knows how many, so the probe deliberately carries an empty pool and reads the refusal's occurrence count. Both calls write nothing. |
| Send | `apply(reviewed)` | Applies EXACTLY what was reviewed. It re-derives nothing. |

### What the browser holds, and what it must never re-derive

**Three refs, and each one is a ref for a stated reason.**

- `roundIdRef` — client-minted, stable for the life of the wizard. The derived child identities are
  keyed on it, so re-minting on a retry would make the retry a *different* round: a transport
  failure followed by a second click would create a second set of cycles instead of replaying the
  first.
- `selectionDigestRef` — arrives with a server answer. Folded into the memoized body it would change
  `bodyRevision`, which is what blocks the send when the form no longer matches the review — so
  every answer would invalidate the review it had just produced.
- `reviewedRef` — the fingerprint, the minted target identities and the command uuid. **Sections 6
  and 7 of the canonical pre-image canonicalize `target_slot_id`**, so the fingerprint binds the
  identities: re-minting between review and send produces a different fingerprint and the core
  answers `source_drift` — a message about the operator's sources for what would really be a client
  defect. No review artefacts, no send.

The browser never sees or constructs a source slot array, on any hop, and could not: the derivation
bridges are granted to no client role.

### `selection_moved` is its own outcome

Not `unknown` — nothing is uncertain, the server was clear and nothing was written. Not
`creation_failed` — there IS something to rebook, it simply is not what the page last showed. It has
its own persistent, focused notice in both locales, it clears the review and the digest, it blocks
the send, and it is **recoverable on the same page**: asking again clears the notice and re-arms the
send. Both wizards have a flow control for exactly that.

### Three defects the cutover surfaced

1. **`crypto.randomUUID` is not always there.** It requires a secure context, so it is undefined on a
   plain-HTTP host and in jsdom — and both wizards mint their round id at MOUNT, which would have
   thrown rather than degraded. `newSelectionUuid` falls back to `getRandomValues` and sets the
   version and variant nibbles by hand. `Math.random()` is deliberately not a further fallback: a
   round id collision is a round created on top of another round's children.
2. **`AcademyNewRoundWizard` never sent an academy.** The retired edge function resolved it from the
   source cyclus; the typed surface authorizes against the academy the CALLER names and re-anchors
   the cyclus to it, so an omitted academy is a call that can only be refused.
3. **`academyProfileId` and location ids are validated, not coerced.** The old fixtures used `'ac1'`
   and `'loc1'`; those are refused before a call is made, which is correct and which the edge-function
   fixtures never had to care about.

### What was deleted with the producer

`readTypedErrorBody`, `decodeTerminalBody` and `verifyCreation` — three decoders for the retired
edge function's response shapes. A decoder for a producer nothing calls is a fallback path waiting
to be re-wired. The RULES they enforced did not go with them: an incomplete answer is still never
read as proof of absence, a transport failure still never claims the round does not exist, and no
accounting is ever reconstructed from numbers the client did not observe.

**`parsePriorityRefusal` went too, and the `priority_refused` arm stayed.** The typed intent has no
priority fields at all, so supplementary priority can no longer be submitted and therefore can no
longer be refused — the ABC-26 runtime refusal became a structural impossibility, which is strictly
stronger. Removing the operator-facing outcome and its notice would be a product decision, so it is
left standing and recorded here instead.

## TWO PRODUCT BLOCKERS THE CUTOVER CANNOT SHIP WITHOUT AN ANSWER TO

Both are properties of the FROZEN contract, not of the client. Both are now safe — the review is
shown, the send is withheld, and a persistent notice names the actual rule — but neither is fixable
inside this scope.

### 1. A session price makes a round un-appliable

`rebook_round_preview_normalized_core` sets `apply_eligibility` to `refused_session_price` for ANY
non-null `p_session_price`, and the apply refuses it before consuming a capability. Both wizards
carry a price field, and both PREFILL it from the source term's modal price — so this is the
ordinary case, not an edge one. The legacy producer supported a per-round price override; the typed
path does not.

**The decision:** remove the price field from both wizards, extend the typed apply to accept a
session price, or ship with the field present and permanently refused.

**Until then** the operator gets `RoundNotPermittedNotice` with the `session_price` reason, which
names the remedy (clear the field) rather than a generic failure.

### 2. No existing round can be extended

The extend path is fenced on the round's **stored normalized policy**, and ABC-27 states the
consequence itself: *"A round with no stored normalized policy therefore CANNOT be extended under
this contract … that is fail-closed, and it is the honest answer while Stage 7.4-C is the only thing
that will ever write one."* Every round in production was created by the retired producer, so none
of them has one.

This is not the missing `expectedVersion` it first looks like. Supplying a version would move the
refusal one step later, into the policy lookup, and it would still refuse.

**The decision:** backfill a normalized policy for existing rounds, keep a legacy extend path alive
for them, or accept that extending is only available for rounds created after the cutover.

**Until then** an extend that the server refuses is reported as `extend_unavailable` rather than as
"we could not confirm what happened" — the surface answers every refusal with one closed row on
purpose, so it cannot say which rule fired, but the CALLER knows it asked to extend.

## The transport subject — `20261203260000` … `20261203280000`

**The premise that turned out to be false.** A superseded `20261203260000_d7_transport_vocabulary_widening.sql`
widened seven routines it described as "the event-blind transport", on the reading that their
`event_type` test was the only thing tying them to member-open. Measured against the installed
bodies, none of the seven is event-blind: every one reads
`notification_outbox.related_rebook_round_recipient_id`, and five go further, into
`abc27_a_member_decided`, `abc27_a_write_decision`, `abc27_a_write_incident` or `issue_delete_pair`.

`rebook_round_recipient_decisions` carries a composite foreign key
`(rebook_round_recipient_id, rebook_round_id, academy_profile_id) → rebook_round_recipients`. An
invitation has no recipient row, so it can never have a decision row. Widening the event test alone
would have let `close_unresolved` pull an invitation into a decision write — and that failure aborts
the whole batch, taking the member-open rows in it down as well. **Widening without a subject is not
a smaller step toward the generalization; it is worse than not widening.**

**The audited split, which is what shipped.**

| | Routines | Why |
|---|---|---|
| Widened, subject-resolved | `claim_batch`, `begin_dispatch`, `record_dispatch_outcome`, `recover_expired_leases` | They lease, dispatch, record and recover. Their subject is read as `coalesce(recipient, claim)`, unambiguous because `chk_notification_outbox_transport_subject_exclusive` makes two subjects unrepresentable |
| Widened, projection only | `dispatch_status`, `dispatch_status_by_capability` | They report and issue no grant. They keep projecting the snapshot column, which is NULL for an invitation — a claim id is not something a status reader needs to disclose |
| **Not widened, by design** | `pre_dispatch_resolve`, `close_unresolved` | Both carry member-open semantics. An unresolved invitation instead waits for an operator, which is what `ODB_UNKNOWN_IS_CLEARED_ONLY_BY_AN_OPERATOR` already required |

**The guard's INSERT arm gets a branch, not a widening.** `20261203280000` first left the invitation
unvalidated on INSERT, reasoning that `d7_p_invite_recipient_snapshot` is granted to Domain A while
the guard runs as Domain N. That was wrong: `20261203250000` grants both bridges to `v_n` — the
CONSUMING owner — for exactly this purpose. So the invitation now gets its own branch that resolves
the claim through the tenant-fenced bridge and holds it to the same identity rules member-open has:
no person id, a guest claim carries that guest and no account, a profile claim carries that profile's
own account. Without it, `chk_notification_outbox_priority_claim_invite_shape` would have been the
only thing between an invitation and a recipient identity that is not the claim's.

**Where the subject domain comes from.** Domain A holds no grant on `public.notification_outbox` —
no `abc27_a_*` routine reads that table. So the issuing authority cannot prove a caller's claimed
subject against the row, and the domain is instead *derived* at the only place that already holds the
row: the machine entrypoint, from `o.event_type`, through the total map
`rebook_round_transport_subject_domain_for_event`. A caller cannot pass a domain that disagrees with
the row because it does not choose one, and `abc27_a_authorize_transition` refuses anything outside
the closed vocabulary regardless.

**Neither subject column carries a foreign key**, and that is the design rather than an omission. A
claim is deleted by the shipped guest-merge path; an FK would either cascade that deletion into
transport state or block the merge on a lock the merge never manifested.

## The protected invitation enqueue — `20261203290000`

The transport accepted an invitation as a subject and nothing could put one there:
`rebook_member_open_enqueue_core` is the only routine that initializes `transport_state` and it is
revoked from `service_role`; `enqueue_notification` — the one enqueue the machine role reaches —
never touched a transport column. The owner chose **Option 2**: extend that existing entrypoint,
keep the machine surface at nine, and keep invitations manager-triggered.

**The branch is an exact equality on one literal event key**, written beside ABC-27's own refusal
for the other protected type and deliberately NOT a membership test against the protected set — a
second protected type must be a reviewed decision, not an inherited one. It delegates to
`rebook_priority_claim_invite_enqueue_core`, which is Domain-N owned and revoked from `service_role`
exactly as its member-open counterpart is. **An entrypoint is what the machine role can call, and
that one it cannot**, so the surface is still nine and the contract test pins it by name.

**Two constraints had to widen, and they were found by inserting rather than by reading.**
`chk_notification_outbox_transport_scope` allowed transport state only on member-open — it blocked
the enqueue outright. `chk_notification_outbox_transition_action` allowed a transition action only on
member-open, which would have let the row be created and then refused every dispatch it ever
attempted; that is the worse of the two, because it surfaces only once a send is tried. Both keep
every other arm verbatim.

**The frozen bytes are the provider request body, not a digest input.** The worker POSTs
`canonical_request_bytes` verbatim, so everything the invitation needs on the wire is in them. A
first version copied member-open's four fields and would have silently stripped the academy
branding, the reply-to and the List-Unsubscribe header the shipped sender sets. The envelope stays
under the database's control even though the body is rendered upstream: the caller chooses a DISPLAY
NAME, never the address, and control characters and RFC 5322 quoting metacharacters are stripped, so
a display name cannot close the phrase and forge an address.

**The address rule was traced, not assumed.** A guest claim routes to the guest's own address and
nowhere else; a profile claim to that profile's. A draft used `guest ?? profile`, copied from
`personContactEmail` — a helper a *different* caller uses — and that would have mailed a child's
invitation to the linked parent's inbox, which is the exact defect the sender's own comment says it
was changed to stop doing.

**Send-then-stamp became enqueue-then-stamp.** The old order left a real hole: a provider call that
succeeded while the stamp failed had no durable database record, and only Resend's 24-hour window
stood between that claim and a duplicate. Now the enqueue IS the record — one row, its transport
state and frozen request written in the same statement, under a unique idempotency key — so a second
enqueue returns `already_enqueued` permanently, not for a day. A failed stamp is no longer dangerous,
because re-enqueueing is a no-op.

**A live send must have a round — supplied or derived.** `rebook_priority_claim_invite` declares
`requires_rebook_round`. The wizard knows the round it just created, so it is threaded from
`drainAndReport` through `drainRebookRoundInvites` and `drainRebookInvites` to the edge.

Three live callers do NOT know one: the per-claim re-invite and the invite-everyone-on-this-slot
button in `PriorityClaimsSection` (rendered on both slot-detail pages), and
`notifyPriorityClaimsForSlots` from the bulk-copy wizard. A first version of the cutover demanded
`roundId` up front and would have 400'd all three. A second read the claim's round in the EDGE and
failed the schema-reference gate: `rebook_round_recipient_claim_sources` is a Domain-A relation, and
no ABC-27 round table appears in the generated Supabase types.

So the DATABASE derives it, through `abc27_a_claim_round` — A-owned, granted to Domain N alone,
which is the shape ABC-27 already uses for every A fact its N-owned writers need. A claim that
belongs to no round is REFUSED rather than sent another way; there is deliberately no fallback,
because an untracked send is the thing this path exists to remove. A test send never enters the
transport and needs no round at all.

## What review round 1 of the enqueue found — `20261203310000`

An independent adversarial review of `20261203240000`–`20261203300000` returned **four P1 defects**.
All four were real, and none was an evidence gap — each was a behaviour the tests happened not to
reach. They are recorded here in full because three of them are the same mistake wearing different
clothes: *the batch stopped at the boundary its tests stopped at.*

**P1 · An invitation could never reach the provider.** The enqueue worked and nothing downstream did.
The worker calls `pre_dispatch_resolve` unconditionally and it was still filtered to member-open, so
an invitation was refused `capability_mismatch`. Past that, `begin_dispatch` was fenced to hand a
priority-claim subject a NULL eligibility and refused again. That NULL was correct when it was
written — there was no eligibility authority for an invitation — but the claim itself is one, and
`d7_p_invite_contact` already reports whether it is still pending. The resolver now answers an
invitation from an EARLY-RETURN branch, before a line of member-open policy runs; `begin_dispatch`
reads the same fact. Every test stopped at enqueue, which is why nothing could notice.

**P1 · One invitation could stall a batch of member-open rows.** `20261203270000` widened
`claim_batch`'s internal cursor to a coalesced subject and did NOT widen its `RETURN QUERY`, which
still projected `related_rebook_round_recipient_id` — NULL for an invitation. The worker's decoder
requires a UUID there and rejects the WHOLE batch, so a single invitation would have left every
member-open row leased until the janitor recovered them, and could poison the next batch too. This
directly violated "member-open behaviour unchanged". **The exact-count assertions did not catch it
because each site was individually correct — the count was right and the SET was wrong.**

**P1 · A supplied round was never checked against the claim.** `coalesce(p_round, derived)` accepted
any non-null UUID: not that it belonged to the tenant, not that it captured this claim, not that it
was related to the claim at all. Academy A could attribute an invitation to academy B's round.
`abc27_a_resolve_invite_round` now makes the DERIVED round authoritative and accepts a supplied one
only when it agrees — or, when the claim has no capture record, only when it is genuinely that
academy's round.

**P1 · Every non-cycle entry mode was refused before enqueue.** `academyProfileId` was assigned only
in `cycleId` mode, so the live `claimIds` and `slotId` modes passed NULL as the tenant and the core
raised "tenant and claim are required" for all three callers. The academy is on the claim's own slot,
and `availability_slots` is an ordinary product relation, so it is resolved per slot.

**P2 · The domain agreement proved the wrong thing.** Consumption proved
`target.target_domain = grant.subject_domain` — that the grant agrees with ITSELF — and never that
either equals the domain the outbox row's event type implies. A grant minted as `snapshot_member`
over an invitation's outbox id and claim id was internally consistent and would have been accepted.
The guard knows the row's event type, so it now passes the derived domain into the consume, which
matches on it. The delete path pins the literal instead: it requires a recipient decision an
invitation can never have.

**P2 · An explicit re-invite reported success while sending nothing.** The idempotency key is
permanent, so a second enqueue can never produce another message — including for `resend: true`,
which nonetheless stamped `invited_at`, incremented `sent` and showed "Invitation sent". An
already-queued claim is now reported as skipped, so the count a manager reads is the count of
messages actually queued.

**P2 · A comma in an academy name would have split the From header.** The edge sanitizer deliberately
KEEPS commas, because the direct-send path it was written for wrapped the display phrase in quotes.
This path strips quotes, so `Academy, Name via PadelTrainer.ai <noreply@…>` would have parsed as an
address list. The bytes are permanent once enqueued, so the character is removed rather than escaped.

**P3 · The "EVERY producer declares occurred_at" pin omitted the new producer.** It was added to the
inventory and not to the per-file list beside it, so deleting `p_occurred_at` from the new call would
have left a test with "EVERY" in its name green.

## What review round 2 found — `20261203320000`

Two more P1s, and both are the same class as round 1's: a fact re-read at the linearization point
that was not re-read far enough.

**P1 · Dispatch re-read the claim's status and not its identity.** A claim's `player_id` /
`guest_player_id` are mutable by the slot owner while its status stays `pending`. So: claim `C` is
pending for Alice, the sender freezes bytes addressed to Alice carrying claim token `T`, the slot
owner repoints `C` at Bob, and both `pre_dispatch_resolve` and `begin_dispatch` see
`still_pending = true` and authorize. The worker then POSTs Bob's bearer token to Alice's inbox.
The INSERT guard proves identity at enqueue and nothing re-proved it at dispatch — which is the only
moment that matters, because the linearization point is where every other fact is re-read. Both now
require the claim's CURRENT routing identity to be the one the frozen bytes were built for: the same
guest, or the same absence of one, and the same destination address.

**P1 · "No capture here" is not "no capture anywhere".** `abc27_a_resolve_invite_round` filtered
provenance by claim AND academy, so a claim captured by academy B's round looked *uncaptured* to
academy A — and A's fallback then accepted any round of A's own. The source table deliberately has no
live claim FK, so that provenance survives a claim being moved between academies. Provenance is now
read for the CLAIM, and a capture belonging to another academy is a refusal rather than an absence.

**P2 · A hold that wrote nothing was not a hold.** The early branch returned `held` and wrote
nothing, so the row stayed `leased`. The worker returns on any non-proceed disposition assuming
durable state exists; the janitor later restored the row to its exact claimable origin, and it could
be claimed, held and recovered forever — burning a lease in every batch. `held` now moves the row to
`configuration_hold` through the same authorize-and-present machinery every other transition uses.

**P2 · A suppressed address was reported as sent.** The core returns before its only INSERT, so no
row exists and `invited_at` stays null — yet the endpoint answered `sent: 1` and the client, seeing
no failures, declared the drain complete while the claim stayed eligible forever. Suppressed and
already-queued now both report as skipped, and a source pin names both reasons and the outcome each
must produce, because that branch has no reachable unit harness.

**P3 · A skip was shown as "already responded".** For a still-pending claim whose invitation is
already queued, that was simply false. The copy now says no new invitation was queued, in both
languages.

## What review round 3 found — `20261203330000`

Four more P1s. Three are again the same shape — a fact re-read at the linearization point that was
not re-read far enough — and the fourth is about what "once per claim" actually means.

**P1 · The early return skipped every operational gate.** Returning `proceed` straight after the
identity test meant an invitation never reached the shared checks below it, so it would have gone to
the provider while the email channel KILL SWITCH was active, INSIDE QUIET HOURS despite its event
declaring `quiet_hours_respect`, and to an address hard-bounced or complained AFTER enqueue —
suppression having only ever been checked at enqueue, and a durable row can wait a long time. The
branch now runs the same three gates with the same functions, the same transport states and the same
authorize-present-release-the-lease shape the member-open path uses.

**P1 · Identity meant too little.** Round 2 compared the guest and the address. Two facts move
independently of both. **The person:** profile emails are explicitly non-unique, so repointing
`claim.player_id` from Alice to Bob — same address, both guest ids NULL — passed, and Alice then
received a bearer token that `respond_to_priority_claim` books for Bob, because it reads the LIVE
claim. **The session:** `claim.slot_id` is mutable too, so the frozen HTML described S1's date, time
and price while the token booked S2. The slot had nowhere on the row to be compared against, so the
enqueue now stamps it — server-derived from the bridge, never from the caller's payload — into the
payload the guard already makes immutable.

**P1 · "Once per claim" was only once per claim per tenant.** `uq_notification_outbox_idem` includes
the generated `tenant_scope_key`, so a claim that moves academies gets a new scope key and a second
row — and, past the provider's own time-bounded window, a second provider send. The enqueue now
refuses when any row exists for the claim in any tenant. Dispatch also re-resolves the round, so a
stale row cannot still send for a round the claim has left.

**P2 · A suppressed address was still swallowed.** `readChunkResponse` discards `skipped`, so a chunk
of nothing but skips reads as a clean drain while the claim stays unstamped and is rediscovered
forever. Suppressed addresses and non-sendable existing rows now travel on the `unresolved` channel
the drain already propagates and the wizard already reports.

**P2 · `already_enqueued` hid rows that could never be sent.** The conflict path did not look at the
existing row's state, so a HELD row reported the same thing as a queued one — and a manager pressing
resend was told the player had already been invited while nothing could ever be queued again. The
conflict now distinguishes `already_enqueued` from `existing_row_not_sendable`.

**P3 · A hold kept its lease metadata**, claiming forever to be owned by a worker that had finished;
every transition now clears `locked_by` and `locked_at`. **P3 · A live enqueue required the provider
key** it no longer uses — the check moved to the one path that still calls Resend, the test send.

### Two survivors the mutation battery caught, and what they meant

`M12` (guest falls back to the profile address) SURVIVED after round 3, because that migration drops
and re-creates `d7_p_invite_contact` — the mutant was editing a copy that never reaches the database.
`M27` (a claim may be enqueued under a second tenant) SURVIVED because the test stopped at the tenant
fence in FRONT of the guard it claimed to exercise: the claim has to actually move to the other
academy's slot AND be captured by it before the cross-tenant check is even reached. Both are recorded
because they are the same lesson in two forms — **a mutant that cannot reach the code proves nothing
about the sensor.**

## What review round 4 found — `20261203340000`

**P1 · `begin_dispatch` did not re-resolve the round.** Round 3 taught the resolver to re-check which
round a claim belongs to and did not teach begin the same. They are separate RPCs, so between them a
claim could be captured by a newer same-academy round while person, address, guest and slot all
stayed put — and begin would authorize the stale round's invitation. Both now ask about the row's OWN
round, which also fixed a false refusal: dispatch was calling the resolver with `p_round = NULL`, so
a claim with no capture record — legitimately enqueued against a supplied same-academy round —
resolved to NULL and was held every single time.

**P1 · The stamped slot proved the claim, not the offer.** `d7_slot_id` recorded which slot the claim
sat on WHEN THE ENQUEUE RAN; the bytes were rendered earlier, from a separate read. So the claim
could move between rendering and enqueue (stamp agrees, bytes describe another session), and the
slot's own time or price could be edited after enqueue (id still matches, offer stale). The caller
now states which slot it rendered from and the enqueue refuses a mismatch, and the offer-bearing
facts are fingerprinted at enqueue and re-compared at dispatch.

**P1 · A deferral past the round window looped forever.** Quiet hours can bump past
`member_window_ends_at`. The row deferred, became claimable when its schedule passed, resolved
`proceed`, was refused `window_invalid`, was recovered to a schedule already in the past, and went
round again — with no member-only unresolved closer to end it. A bump past the window is now a hold.

**P1 · The cross-tenant check was check-then-insert.** `IF EXISTS` is not serialized with the INSERT
and the real unique key is tenant-scoped, so two concurrent enqueues under two academies could both
pass and both commit. A transaction advisory lock on the CLAIM makes the pair one decision.

**P1 · Known zero-send outcomes still incremented `sent`.** Both new skip reasons travelled on the
`unresolved` arm, which exists for "the provider call happened and the stamp did not" and therefore
counts a send. That inflated totals, told a single-claim resend "Invitation sent", and kept the
drain's no-progress guard from firing — so the same suppressed claim was re-attempted to the
iteration limit while later recipients waited.

**P2 · "Sendable" was an allow-list, wrong in both directions** — it called the two DEFERRED states
unsendable, which are exactly the claimable ones, and a mid-dispatch `leased` row held. Inverted to
the complement, which is also what stops the next upstream state defaulting to the wrong side.
**P2 · The claim lookup had no index**, so the new cross-tenant check could scan the outbox once per
invitation. **P3 · "Latest capture" could tie**, making the answer depend on which row the planner
returned; the order is now deterministic.

### The mutation battery caught the same lesson twice more

`M12` and `M22` SURVIVED again, for the same reason as round 3: this migration re-creates
`d7_p_invite_contact` and `abc27_a_resolve_invite_round`, so mutants aimed at the previous copies
applied cleanly and changed nothing installed. **A survivor is always two questions — is the sensor
missing, or did the mutant never reach the database?**

## The sealed dispatch contract — `20261203350000` … `20261203370000`

Round 5's list was not ten unrelated defects. Seven of them were two root causes wearing different
clothes, and both were structural:

1. **The assertion vector was never enumerated.** Each round found one more fact the message
   promises and dispatch did not re-check — identity, then the operational gates, then the round,
   then the offer, then the token, the group, the series, the deadline, the payment mode. Every fix
   looked complete and every next round found the next one. A fingerprint over four fields cannot
   protect a message that asserts a dozen.
2. **The same question was answered in three places.** `pre_dispatch_resolve`, `begin_dispatch` and
   the janitor each carried their own inline copy of the eligibility rules, so a correction had to
   land in three bodies to be true, and round 4's did not — it reached the resolver and left the
   janitor restoring rows the resolver had just held.

The three successors replace the design rather than patching it once more:

| Version | File | What it is |
|---|---|---|
| `20261203350000` | `d7_invite_offer_contract.sql` | `d7_p_invite_offer` — ONE reader for every fact the invitation asserts, and `offer_digest` over all of them |
| `20261203360000` | `d7_invite_verdict_authority.sql` | `rebook_priority_claim_invite_verdict` — ONE typed answer (`send` / `defer` / `cancel` + reason + when), asked by resolve, begin AND recovery |
| `20261203370000` | `d7_invite_enqueue_contract.sql` | the enqueue re-created against both: locked first, rendered-bound, keyed by the offer |

### What is now structurally impossible

- **A promised fact outside the digest.** The digest covers the token, the session and its times,
  the price, the deadline, the cycle and its name, start date and payment mode, the group and its
  series shape, the person and the address. `src/test/d7RuntimeContract.realpg.test.ts` sweeps them
  one at a time — a test per fact, because a whole-digest test passes just as happily with one
  column quietly removed.
- **An unbound render.** `d7_rendered` is REQUIRED and all fifteen fields are compared. Round 4's
  version fired only when the field was present, and the helper omitted it — so most of the suite
  proved the bypass. The absence case is now its own test, and so is each field.
- **A second opinion.** The resolver, `begin_dispatch` and `recover_expired_leases` consult the
  verdict and nothing else; the migration refuses to install if any of them still carries an inline
  pending re-read, suppression check or channel-kill check inside the invitation branch. The
  member-open policy that lives *below* that branch is asserted to survive in the same breath —
  scoped to the branch, because a whole-body check would be false in one direction and vacuous in
  the other.
- **A dispatch that outlives the offer.** The idempotency key is claim + round + offer digest, so a
  changed offer is a different message with its own row, and an unchanged one can never be sent
  twice. The ROUND is in the key and deliberately NOT in the digest: it is not one of the offer's
  terms — the message promises a session, a price and a deadline, not a round id — but it is part of
  which invitation this IS. Review round 1 found why that distinction is load-bearing: the outbox
  guard consumes a transition grant against the row's own `related_rebook_round_id`, while the
  enqueue issues one for the round it has just resolved. A claim re-captured by a later round
  therefore reached the earlier round's row and its restore was refused by a mismatch nothing could
  resolve — the same hard error on every retry, for as long as the offer stayed the same.
- **A stale read under a moving claim.** `pg_advisory_xact_lock` is taken before the authoritative
  read, not merely before the outbox check, and both the migration and the suite assert that
  ordering from the installed body. One statement precedes it — the null-argument guard, which
  needs no lock and cannot race — so "first statement" is loose; what is asserted, and what matters,
  is that nothing is READ before it. Note the limit named as OD-5 below: it serializes competing
  enqueues, not the product's own writers.

### Timezone-invariance, which is a correctness property and not a nicety

Every instant enters the digest as `extract(epoch FROM …)`, never `::text`. A `timestamptz` rendered
to text goes through the session `TimeZone`, so an enqueue in Europe/Amsterdam and a dispatch in UTC
produced two digests for one unchanged offer and held a legitimate invitation. The migration refuses
to install if any instant reaches the digest as text; the suite proves the consequence by moving the
session zone between the two reads and requiring the digest not to move.

### The defect the contract itself surfaced — two sources for one name

Writing the sweep turned up a live defect that five review rounds had not: `cyclus_name` exists
**twice**. There is `cycles.name`, and there is the denormalized `availability_slots.cyclus_name`
column on the session. The email prints the SESSION's copy; the first draft of the offer contract
digested the CYCLE row's name.

Nothing in the suite could see it, because the test helper reads its "rendered" facts from the
server — so both sides agreed by construction. In production the two disagree the moment a slot
label drifts from its cycle, and the enqueue would then compare a name the sender never rendered and
refuse **every** invitation with `changed between rendering and enqueue`. A total outage of the
invitation path, produced by a check added to make it safer.

The contract now reads `s.cyclus_name`, and `src/test/rebookOrchestrationWiring.test.ts` pins the
PAIR — the sender's source and the server's source, in one test — because pinning either half alone
is what allowed them to drift apart in the first place.

And then the same trap a second time, in its NULL form: `availability_slots.cyclus_id` is nullable,
and the sender derives `payment_mode` from a BOOLEAN — `isUpfront ? "upfront" : ""` — so a session
with no cycle renders as `''`. The server's first draft returned NULL there, which would have refused
every invitation for a cycle-less session. It is canonicalised to `''` now, and a test enqueues a
claim on a cycle-less session to prove it.

**The durable fix is a test the fixture cannot satisfy by construction.** `SOURCE AGREEMENT` derives
all fifteen facts a SECOND time — from the sender's own relations, transcribed — and requires the two
derivations to be equal for three shapes: a plain session, a session in a series, and a session with
no cycle. Its fixture deliberately sets `cycles.name` to something completely different from
`availability_slots.cyclus_name`, so a server that read the wrong one fails immediately.

*The general lesson: a fixture that derives the caller's facts from the callee cannot test whether
they agree. Whenever a check compares two independently-derived values, at least one of them has to
be pinned to its real source in a test the fixture cannot satisfy by construction.*

### `RE_INVITATION` — A, B, then A again

`A_KEY_INCLUDES_OFFER_DIGEST`. Going back to a superseded offer returns to that offer's OWN row, and
only if it never left: `configuration_hold`, `first_dispatch_at IS NULL`, no authorized generation,
status not `sent`. Anything that reached the provider — sent, attempted, `acceptance_uncertain`,
`awaiting_reconciliation` — is never automatically reposted or reactivated; it is reported as
`existing_row_not_sendable` and left for an operator. Both directions are proven: convergence onto
the same row and key, and a row stamped with `first_dispatch_at` staying exactly where it is.

### What a HELD invitation means operationally

A cancelled verdict never deletes and never sends. The row moves to `configuration_hold`, leaves the
claimable set, keeps its frozen bytes and waits for a person. That is deliberate: the bytes carry the
offer as it was, so the only two honest options are "send exactly this" and "do not send this".

Recovery is not a separate mechanism — the manager simply invites again — but which of two things
happens depends on whether the offer moved, and the distinction matters:

- **The offer changed.** The key is claim + round + offer, so the current offer produces a DIFFERENT
  key: a new row is created and queued, and the superseded row is left exactly as it was.
- **The offer is identical and the row never reached the provider.** The key is the same, so the
  enqueue finds that row and restores it — `configuration_hold → queued`, under a `transport_recovery`
  grant. This is the A → B → A case, and it is the only circumstance in which a held row is revived.

Anything that reached the provider is never in the second case: `first_dispatch_at`, an authorized
generation or a `sent` status all take it out, and it is reported as `existing_row_not_sendable`
instead. That is what `RE_INVITATION_SAFETY` requires.

The one case that does need a human is the opposite direction: a row that reached the provider and
came back unknown (`acceptance_uncertain`, `awaiting_reconciliation`). That is `ODD`'s
operator-facing mark-resolved control, which still has no surface — recorded, not skipped, in the
round-5 section below.

### What the manager sees

`zero_send` is no longer reported as success. The per-player button and the invite-all button both
read the `unresolved` channel and say so; the drain denominator counts unresolved attempts, which it
did not, so a progress bar could render more parts than whole. And no surface says "sent" any more —
`invited_at` records a durable ENQUEUE, and with every D7 schedule inactive nothing downstream has
been delivered. "Queued" is the honest word in both states.

### The mutation battery for the sealed contract

Thirty mutants across the three files, each recorded with the assertion that caught it. Two rules
were applied that earlier rounds learned the hard way:

- **Every mutant must reach the installed database.** Each one targets the LATEST definition of its
  routine — rounds 3 and 4 both produced survivors that were simply unreachable, because a later
  migration re-created the function the mutant had edited.
- **A mutant stopped by the migration's own guard proves the guard, not the sensor.** Three mutants
  were written as evasions and STILL tripped their guards on the first run — the timezone one
  neutered the wrong `LIKE` pattern, the recovery one deleted the routine name the guard greps for,
  and the key one deleted the `|| f.offer_digest` substring the guard greps for. Rewritten to keep
  the guarded text and break only the behaviour, all three now land on real assertions: the
  timezone-invariance test, the recovery test, and the A → B → A convergence test. The
  provider-reach gate is carried twice on purpose — once removed outright (guard-caught) and once
  made inert while keeping all three witnesses (suite-caught).

**Result on the final bytes: 30 mutants, 29 caught, 1 survivor, integrity clean before and after.**
Every catch is attributed to a named assertion. The three that are not a plain sweep hit:

| mutant | caught by |
|---|---|
| the label is digested from the CYCLE row instead of the session | the sender/server source-pair pin |
| the payment mode answers NULL for a session with no cycle | `A SESSION WITH NO CYCLE ENQUEUES` and `SOURCE AGREEMENT` |
| every witness of provider-reach made inert | `A ROW THAT REACHED THE PROVIDER IS NEVER REACTIVATED` |

The battery also produced a process lesson worth keeping: a run killed mid-mutant leaves the
migration edited, and a second run then snapshots the mutation as its "original" and restores it
forever. The harness now asserts every anchor is present exactly once BEFORE it starts and again
after it finishes, and refuses to run on a tree that is not pristine.

**The survivor that taught the isolation rule.** The first series case added a sibling session at the
end of the group — which moves the LAST START as well as the count, so deleting `group_sessions` from
the digest changed nothing the suite could see. The series is now three cases against a four-session
group with the claim in the middle: withdraw the middle sibling (count only), move the earliest
(first only), move the latest (last only). *A sweep that does not isolate its fact is not a sweep.*
The same rule produced the two identity cases: repointing a profile claim at a guest moves the guest
id AND empties the account id, so neither was individually proven until a guest→guest case (guest id
only) and a re-pointed `profiles.user_id` case (account id only) were added.

**The survivor that stayed one.** Weakening `o.first_dispatch_at IS NULL` alone in the restore gate
changed nothing observable — and that is correct rather than a gap. ABC-27 writes `first_dispatch_at`
and `dispatch_authorized_generation` in the SAME statement (`:8041`), and a trigger makes the
generation *monotonic and never clearable* (`:6064`), so no legally reachable row carries one witness
without the other. The mutant is unreachable, not missed. Because that is a claim about the schema
rather than an excuse, it is now asserted: a test arms a real dispatch, requires both facts to be
stamped together, requires an attempt to clear the generation to be refused with the arming intact,
and requires the gate to name all three witnesses. The reachable question — can a row that reached
the provider be restored at all — is its own mutant, which the suite catches.

### Gate evidence for the sealed contract

Measured on the final bytes, all local:

| Gate | Result |
|---|---|
| `vitest --project db` | 163 files / 2,924 tests, all passing |
| `vitest --project unit` | 389 files / 3,802 tests, all passing |
| `npm run test:edge` | 783 passing |
| `npm run lint` | clean |
| `npm run typecheck:baseline` | no new type errors (82 pre-existing, baseline 82) |
| `npm run build` | clean |
| `check:edge-config` / `check:legacy-key` / `check:edge-pins` / `check:edge-types` | all OK |
| `npm run i18n:check` | parity OK, 0 missing |
| ABC-27 frozen file | `05e04451f944cabf` · 20,633 lines, unchanged |

Two gate failures during this batch are worth recording because both were the gate doing its job on
something the batch had genuinely broken, not noise:

- `notificationAttributionMatrix` failed with *no `enqueue_notification` call found* — the call-site
  regex window is 1,600 characters and the invitation call grew past it when it gained the fifteen
  rendered facts. The window is now 6,000, and the "at least one call" assertion is the only reason
  a vacuous pass showed up as a failure at all.
- `eslint` caught an unused destructured binding left behind when the placement test was rewritten
  to use a second round.

## The sealed contract's review round 1 — what it found, and what changed

A fresh `gpt-5.6-sol` / `ultra` read-only pass over the final bytes. It ran as a coordinator with
three specialised readers (offer agreement, invariants/tests, verdict/state) and returned a large,
mostly-valid set. Nine were corrected in this batch; five are owner decisions and are listed after.

### The one that would have bitten first

**A claim re-captured by a later round was permanently un-invitable.** The outbox guard consumes a
transition grant against the ROW's own `related_rebook_round_id`; the enqueue issued one for the
round it had just resolved. With the round absent from the key, a re-captured claim reached the
earlier round's row — same claim, same unchanged offer, same key — and its restore was refused by a
mismatch nothing could resolve. Every retry produced the same hard error, for as long as the offer
stayed the same.

Fixed by putting the round in the KEY and deliberately not in the digest: the round is not one of
the offer's terms, but it is part of which invitation this IS. A first attempt digested it instead,
which worked but made `placement_incoherent` unreachable at dispatch — the key is the right home.

### The rest of what was corrected

| # | Finding | Correction |
|---|---|---|
| P1 | An OMITTED rendered key passed as "equal to null" — nine of fifteen for a cycle-less, groupless, priceless session | The fifteen keys are required with `?&` before equality is asked |
| P1 | The sender trims with JS `.trim()` (all Unicode whitespace); the offer used `btrim` (ASCII spaces) — an imported address in tabs or NBSP refused every enqueue | `d7_trim_ws` strips the same class on both sides |
| P1 | The mail quoted `Number(x).toFixed(2)` while the seal used PostgreSQL rounding — a stored `2.675` is quoted as 2.67 and was sealed as 2.68 | The echo is the RENDERED STRING and the server compares that exact text, so a divergence refuses |
| P2 | Cycle start rendered one day late in every zone at or past UTC+12 (a plain DATE anchored at noon UTC and then converted) | Rendered in UTC — the value has no time and no zone |
| P2 | The per-claim Invite button was ungated on an expired window, so the manager was told "queued" for a row that can only become `configuration_hold` | Invite is gated like Invite All; Release is not |
| P2 | The group-claims read paged `status='pending'` by OFFSET — the exact case `paginate.ts` documents as unsafe | Switched to `fetchAllInChunks` (keyset), with a test where a sibling answers mid-read |
| P2 | *Test-quality:* the monotonicity proof was false-green — the transport guard throws first, and its companion checked only an error message's text | Asserted from the installed trigger body: the OLD/NEW comparison and the decrease refusal |
| P2 | *Test-quality:* the zero-send pins matched text anywhere in the file, so replacing the live call with a literal left them green | The live `await enqueueOne()` call site is pinned, and a fabricated success is refused |
| P3 | *Test-quality:* nothing tied the sender's fifteen-field object to the server's fifteen-field requirement — deleting `cycle_start` left everything green | The two lists are compared to each other, statically, as sets |
| P3 | *Test-quality:* `SOURCE AGREEMENT`'s guest arm was dead — all three shapes used a profile recipient | A fourth shape rekeys the claim onto a guest, exercising `resolve_guest_member_contacts` |
| P3 | The runbook said re-inviting ALWAYS creates a new row and that un-holding does not exist, contradicting the restore branch | Both cases are now stated, with what separates them |

### What the reviewer confirmed

Frozen ABC-27 byte-exact; exactly nine machine entrypoints; zero `service_role` outbox DML; no new
role, public permission or subject FK; no client-side offer authority; no automatic resend of an
unknown outcome; the recovery arm's transition authorization correct; and the claimed-unreachable
restore-gate mutant genuinely unreachable.

### Mutation evidence for the round-1 corrections

Seven mutants, one per correction, each recorded with the assertion that caught it:

| mutant | caught by |
|---|---|
| the key stops varying with the round | `A CLAIM RE-CAPTURED BY A LATER ROUND IS NOT PERMANENTLY BLOCKED` |
| the rendered keys stop having to be PRESENT | `BINDING — an OMITTED field is refused even when the server's own value is null` |
| the offer reverts to ASCII-only trimming | `WHITESPACE — an address the sender trims and the server did not` |
| the price is compared as a number again | `PRICE — the mail quotes the price the offer seals, to the cent` |
| `begin_dispatch` stops re-asking the verdict | `THE VERDICT IS RE-ASKED AT begin_dispatch` |
| the price leaves the digest | `A ROW THAT REACHED THE PROVIDER IS NEVER REACTIVATED` |
| the key stops varying with the offer | `A → B → A CONVERGES` |

**The price mutant survived its first run, and the lesson generalises.** Reverting the comparison to
`::numeric(12,2)` passed everything, because the test's two prices — 2.67 and 2.68 — differ as
numbers as well as as text. What only the text form catches is a price that is numerically EQUAL and
differently written, so the case is now `2.680` against a canonical `2.68`. *A test that distinguishes
two values does not thereby test HOW they are distinguished.*

The sender's half of that fix — echoing `Number(x).toFixed(2)` rather than the raw column — has no
database sensor at all, because the realpg helper builds `d7_rendered` from the server's own reader.
It is pinned statically instead, beside the field-list comparison.

## Review round 2 — what it found, and what changed

`AUTHORIZE_D7_RUNTIME_FINAL_REVIEW_AUTOPILOT_V1` authorised implementing every valid in-scope
finding without further confirmation. Round 2 ran as a coordinator with three readers (sender scope,
test honesty, SQL contract) and was told round 1's findings were closed and the four remaining owner
decisions were deliberate.

### Three P1s in the seal

- **The seal was not injective.** The digest joined its fields with a pipe. Session labels are free
  text and the enqueue's address pattern admits pipes, so a coordinated pair of values could shift
  the framing and hash IDENTICALLY for a different offer — a stale bearer invitation left authorized
  while both the label and the destination had moved. One-field-at-a-time mutants cannot see that;
  only a constructed collision can, and there is now a test that builds one. The digest is a `jsonb`
  array, which escapes every element.
- **The seal omitted `player_id`.** The series scope became pair-exact, but the digest carried only
  the guest and the account. On a dual-keyed claim, re-pointing the PROFILE half moved nothing
  sealed — guest unchanged, account NULL either way, address the guest's — while the accept's
  pair-exact predicate would book the new profile.
- **The cycle date followed `DateStyle`.** `date::text` is session state exactly as a timestamp's
  `::text` is `TimeZone` state; an `SQL, DMY` session renders the same date differently. Both the
  seal and the enqueue comparison are pinned to `YYYY-MM-DD`, and the catalog guard now refuses
  either form of session-dependence.

### Two P1s where the fences disagreed

`begin_dispatch` fences on the ROUND's member window, sampled once and re-checked after the
eligibility read. For an invitation that was the wrong bound in both directions: the player's own
`priority_window_ends_at` was never fenced there, and a round whose member window is NULL or
`infinity` was refused outright BEFORE the verdict was consulted — so an invitation with a perfectly
good finite slot cutoff could never begin, while the resolver and the janitor kept calling it
sendable. The fence now takes the cutoff the verdict judged against, which is
`least(priority_window, member_window)` and therefore never later than the round's own.

### The pair-exact decision had an upstream half

Representative discovery still deduplicated GUEST-FIRST, so `(P, G)` and `(NULL, G)` collapsed to one
representative although the accept treats them as different pairs. Only the earliest was enqueued and
stamped; later drains selected that same already-invited representative, reported nothing remaining,
and the other pair stayed pending and uninvited. Discovery, aggregation and description now use one
key. *A decision about what a series IS has to reach every place that asks the question.*

### The bulk-copy path reported success for zero work

`notifyPriorityClaimsForSlots` counted a SLOT as notified whenever the HTTP invoke returned no error,
never reading the per-claim tally the endpoint returns. Bulk-copied claims carry no round provenance
and the enqueue refuses a claim it cannot attribute to a round, so the whole batch could be refused
while the wizard said "N emails sent". It counts claims now, says "queued", and names what did not.

### The rest

| Finding | Correction |
|---|---|
| Seven more surfaces still said "sent" for a durable enqueue | resume, cohort, manage and progress copy moved to "queued" in both locales |
| Resume omitted the round it already knew, so the server resolved it from latest provenance | the manage page passes its own `roundId` |
| The window gate was computed only at render, so an idle page kept live Invite buttons past the cutoff | a timer re-arms on the deadline itself |
| *Test-quality:* the `round_moved` arm had no sensor — the re-capture test never resolved the OLD row | it now requires the superseded row to be held on that exact reason |
| *Test-quality:* the enqueue call-site pin was satisfied by flipping the `isTest` ternary | the pin binds the ternary's shape, and the live branch is proven to reach no provider |
| *Test-quality:* the pagination fake had no row cap and treated `.eq` as a no-op | it caps at 1,000 and filters, with a declined-sibling case |
| *Test-quality:* whitespace parity tested 4 of 20 characters | every character, compared against JavaScript's own `trim()` |
| *Test-quality:* the UTC cycle-start correction had no sensor | pinned statically, where the database cannot see it |

**A mutant survived and taught the same lesson twice.** Reverting the date comparison passed
everything, because the test session runs on ISO where both renderings agree — exactly as the price
mutant survived because 2.67 and 2.68 differ as numbers too. *A test that exercises a value under
the default session setting does not test a defect that only the setting reveals.* The case now
sets `DateStyle` explicitly, as the timezone test sets `TimeZone`.

## Review round 3 — what it found, and what changed

Three readers (frontend/tests, SQL contract, transport). Every finding below was implemented under
`AUTHORIZE_D7_RUNTIME_FINAL_REVIEW_AUTOPILOT_V1`. An independent 33-agent sensor sweep ran in
parallel and reached the same conclusion about the seal, with a sharper demonstration.

### P1 · `player_id` was sealed, but not BOUND

Round 2 put `player_id` in the digest — but the digest is computed from the server's own read AFTER
the rendered-fact comparison passes. So a product writer re-pointing a dual-keyed claim from
`(P1, G)` to `(P2, G)` between the render and the enqueue produced HTML rendered for P1 sealed
against P2, and the mailed bearer token accepts pair-exactly, on P2. The rendered vector now carries
`player_id` too — sixteen fields, not fifteen.

### P1 · The seal's own sensors were satisfiable by a comment

`prosrc` is the function body INCLUDING its comments, so every check for the token
`jsonb_build_array` — the migration's guard, the wiring pin and the behavioural test — was satisfied
by a comment MENTIONING it. The adversarial sweep built the whole mutation: restore
`array_to_string(ARRAY[…], '|')`, leave `-- jsonb_build_array` behind, and all three sensors stay
green. Worse, the behavioural test never constructed a collision at all; it changed one field and
asserted the digest moved, which any encoding satisfies.

Both halves are fixed. The guards strip comments before grepping, and the test RECONSTRUCTS the
encoding: it rebuilds the framed form and the delimiter-joined form from the offer's own eighteen
facts and requires the installed digest to equal the first and differ from the second. No comment
can satisfy that, and the mutant round 3 named — a real `jsonb_build_array` wrapped around one
concatenated string, which passes every grep — is caught by it.

### P2 · A row that could never dispatch was called sendable, forever

With neither a slot cutoff nor a member window the effective deadline is NULL and the verdict
answered `send`, while `begin_dispatch` refuses a non-finite window outright. The row was leased,
judged sendable, refused, recovered — the janitor asking the same verdict and hearing `send` again —
and leased once more, burning a lease in every batch indefinitely. It is now `no_effective_deadline`
and goes to an operator, which agrees with ABC-27's refusal rather than arguing with it.

### P2 · Two verdict calls, two snapshots

The fence and the eligibility each asked the verdict. Under READ COMMITTED that is two snapshots
with no product lock between them, so a transient cancel in the first — whose cancel arms carry no
cutoff, leaving the fence on the member window — could clear before the second answered `send`. The
answer is read ONCE into scalars and both uses share it. (A `record` will not do: plpgsql refuses to
read a field of a not-yet-assigned record even on the member-open branch that never takes it.)

### P2 · Visible is not owned

The non-service path resolved which claims a caller may invite by SELECTing under the caller's JWT
and trusting RLS. PostgreSQL ORs permissive SELECT policies, so "Players read own priority claims"
satisfied a probe meant to prove "Slot owners manage priority claims": a player with a pending claim
could drive the endpoint for their own claim, choose the custom copy, and enqueue and stamp their own
branded invitation ahead of the academy's. Ownership is now PROVEN with the service client against
the slot's trainer or the academy's managers — the rule the cycle path already followed. **RLS
decides what a caller may READ, never what they may COMMAND.**

### P2 · The counting surfaces disagreed with the sender

| Finding | Correction |
|---|---|
| The manage projection keyed invitations guest-first, collapsing two pair-exact offers — reporting "1/1" and driving `uninvitedCount` to zero, hiding Resume while one was unqueued | two keys: identity stays guest-first for names and reminder targets, the invitation count is per exact pair |
| The queued copy was SHADOWED — i18next resolves `key_one`/`key_other` when a count is supplied, and the plural siblings still said "sent" | the plural forms carry the wording, and a test sweeps every plural form in both languages |
| Invite All never read `failed`, so a fully-refused batch read as "everyone has already been invited" | both buttons read `failed` as well as `unresolved` |
| Resume treated a partial-UNKNOWN outcome as success, because `leftover === null` is not `> 0` | an interrupted drain says so, and says the remainder is unknown |
| Bulk accounting treated `sent` and `unresolved` as disjoint (they are not — an enqueue whose stamp fails counts in both) and counted one failure per SLOT however many claims it held | "needs attention" rather than "could not be queued", and unreachable SLOTS counted separately |

## Review round 4 — what it found, and what changed

Four P1s, three P2s, three P3s. Two of the P1s were regressions introduced by round 3's own
corrections, which is the strongest argument for spending the rounds.

### P1 · The ownership proof compared different ID domains — a regression

`availability_slots.trainer_id` is a `trainer_profiles.id`, NOT an `auth.users.id`; the schema maps
them through `trainer_profiles.user_id`. Round 3's proof compared it to `callerUserId` directly, so
every legitimate trainer would have been refused 403 — the fix for a security hole would have taken
the feature away from the people it belongs to. The proof now mirrors the policy's own definition of
an owner, all three arms: the slot's trainer through `trainer_profiles`, a manager of the slot's
academy, and a manager of the club at the slot's location.

### P1 · Authorization could cross tenants after it was proven

Ownership was proven, then the claim, slot, academy and round were re-read from CURRENT state. A
claim moved to another academy in between would be enqueued under the NEW tenant on the OLD tenant's
authority — including the old academy's custom copy. The academy each claim was proven under is now
carried forward, so the enqueue's own fence rejects a moved claim instead of accepting it.

### P1 · A closed cycle was still invited into, and still bookable

`cycles.status` appeared in neither the offer nor the gates. Closing a cycle changes none of the
eighteen sealed facts — it is not one of the offer's TERMS — so the worker went on sending an
actionable bearer invitation into a round the manager had closed, and the accept, which does not
check the status either, booked the player in. The offer reports the status and the verdict holds it
as `cycle_not_open`. Deliberately a GATE and not a digest member: re-opening makes it sendable again.

### P1 · Direct callers bypassed one-invitation-per-series

`cycleId` mode picks the earliest claim of each pair-exact series as its representative; the direct
`claimIds`/`slotId` paths processed what they were handed. A manager inviting the same player from
two weekly slot pages of one series made two live outbox rows — different claims, tokens and digests,
so different idempotency keys — and both could reach the provider for a series ONE click books. All
paths now collapse to the same representative.

### The rest

| Finding | Correction |
|---|---|
| The revised manage counters disagreed with each other — `invitesSent` counted only pending∩invited, so an invited claim that was ANSWERED displayed "0/1 queued" | all three figures are computed over one set |
| The single-invite toast hid `unresolved` behind `sent > 0`, though the endpoint deliberately returns both when a stamp fails | it reports the success AND the thing needing attention |
| *Test-quality:* "one verdict" had no one-call sensor — restoring a second query passes every deterministic test | recorded as a residual: the race is real but only a concurrency harness can catch it |
| *P3:* the deadline read failed OPEN — an error became a null deadline, which reads as "not ended" and re-enabled Invite past the cutoff | an unknown deadline is treated as a closed window |
| *P3:* a second authoritative slot read dropped its error, turning a transient failure into every claim failing | it throws |
| *P3, test-quality:* the no-deadline test covered NULL/NULL only, and `claim_absent_or_foreign` had no sensor at all | both arms now have behavioural tests |

## Review round 5 — the FINAL round, and what changed

Two P1s, three P2s, three P3s. All were implemented under
`AUTHORIZE_D7_RUNTIME_FINAL_REVIEW_AUTOPILOT_V1`. **The five-round ceiling is now spent, so these
last corrections have NOT themselves been reviewed** — that is the honest state of the batch, and it
is stated here rather than left to be discovered.

### P1 · The series collapse held within a request, not across requests

Round 4 made every caller path collapse to one claim per pair-exact series — but only among the
claims THAT CALL was handed. The cycle drain queues week 1; a manager later clicks Invite on week
2's slot page; week 2 is the local "earliest" of its own request and gets its own claim-bound
idempotency key. Two live rows, either link booking the same series.

The series is now read from the DATABASE: every pending sibling of the exact `(group, player, guest)`
key, keyset-paginated like the other discovery reads. A sibling already stamped means the series has
its invitation and nothing further is queued; otherwise the earliest session is the representative —
the same one `cycleId` mode would pick, so the two paths cannot disagree. An explicit `resend` still
targets the claim it was asked for.

### P1 · The cycle-status gate failed open for an orphan `cyclus_id`

The gate tested "status is non-null and not open". A session whose `cyclus_id` names a `cycles` row
that does not exist reports NULL, so no gate fired and an actionable bearer link went out for a cycle
whose lifecycle cannot be established at all. Those rows are expressly possible:
`availability_slots_cyclus_id_fkey` was added `NOT VALID`, and historical orphans were left for
owner-run repair (`20260630120000`). The gate is keyed on the ID instead — a session with NO cycle is
a different, legitimate shape and stays sendable. The real status set is `draft`, `open`, `closed`,
`archived`; `open` is the only sendable one.

*The test had to reproduce inherited data: `NOT VALID` skips existing rows but still enforces every
new write, so the orphan cannot be made through the product today. `session_replication_role =
replica` creates it for exactly one statement.*

### The rest

| Finding | Correction |
|---|---|
| `sent` and `unresolved` OVERLAP by the queued-but-unstamped claims, and the drain treated them as disjoint — 40 queued plus 40 unstamped of 100 read as a set of 140 | the endpoint reports `unstamped`, and the drain subtracts it; an absent field reads as zero |
| `cycleId + testEmail` stamped emailless claims BEFORE the test/live split, so a preview could consume an invitation for good | a test send stamps nothing |
| A queued-but-unstamped invitation was told to the manager as both "queued" and "could not be queued" — introduced by round 4's own correction | it was queued; what failed is the RECORD of it, and that is what it says |

### Carried, not fixed

- **The bulk-copy "Create & invite" default cannot be fulfilled.** Copied claims carry no round
  provenance and the enqueue refuses a claim it cannot attribute to a round. It fails CLOSED and the
  wizard now says so, but the workflow's default action still cannot do what it offers. Giving those
  claims provenance is a product decision, not a correction.
- **The provider-call timeout ends at response headers**, so a stalled body can outlive the worker's
  documented budget. It delays a batch and defers the row to uncertainty recovery; it cannot repost.
- **The member-open worker never uses the capability-bound status reader** after a lost
  `begin_dispatch` response, so a message that was never posted can be parked `acceptance_uncertain`
  and become operator-only.
- **"One verdict call in `begin_dispatch`" has no regression sensor.** Only a concurrency harness
  could catch a second call being reintroduced.

### FIVE OWNER DECISIONS THE ROUND RAISED — not decided here

Each of these is a real finding. Each one's fix changes what the product PROMISES or what it sends,
so `STOP_RULE` puts it to the owner rather than to me.

**OD-1 · RESOLVED — `OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1`.** The offer and the
sender aggregated a guest's siblings guest-first; `respond_to_priority_claim`
(`20260703150000_rebook_strict_accept_and_release.sql`, both the decline loop and the booking loop)
selects them PAIR-EXACT — `player_id` AND `guest_player_id` must both match. A representative claim
`(P, G)` beside a sibling `(NULL, G)` was described as two sessions and booked as one.

The owner ruled: **the invitation's scope equals the booking scope, and the booking scope does not
widen** — no booking, payment, capacity or identity widening. So three places narrowed to the
accept's own predicate, copied including its bare `status = 'pending'`:

- the offer's `grp` CTE (`20261203350000`);
- the sender's series key, which is now `groupSeriesKey` — the group plus BOTH identity columns,
  nulls included. `personKeyOf` stays guest-first where it belongs, for dedup and display;
- the `SOURCE AGREEMENT` transcription, so the second derivation follows the same rule.

The regression test asserts the two AGAINST EACH OTHER rather than asserting a number: it counts the
rows the accept's predicate selects and requires the offer's `sessions` to equal that count, with
the excluded sibling's session proven to be outside the described range. A mutant restoring
guest-first is caught by it.

**OD-2 · Interior sessions of a series are outside the offer.** The group reader seals count, first
start and last start. Accept books every selected slot. Moving a middle session to another weekday
leaves all three aggregates unchanged, so the frozen "Elke dinsdag om 19:00" still goes out and the
Wednesday session is booked with it. Sealing every session's start and end closes it — at the cost
of cancelling an invitation whenever any session in the series is edited.

**OD-3 · The academy timezone is outside the offer.** Every schedule sentence — weekday, time range,
series range, deadline — is rendered through `academy_profiles.timezone`, which is user-editable.
Correcting it between enqueue and dispatch leaves the digest equal and sends the old local time. The
boundary test currently ENFORCES that exclusion, so this is a decision, not an oversight: including
it means a settings correction cancels every live invitation.

**OD-4 · The digest is not minimal to the rendered HTML.** With a custom intro the label is not
printed at all, yet a label change still cancels; a price is printed only when truthy, yet `NULL` and
`0.00` seal differently. Both are fail-closed — they hold or re-key a message rather than send a
stale one — but they cancel invitations whose visible text did not change.

**OD-5 · The advisory lock serializes enqueues, not the product.** `d7-invite:<claim>` is taken by
nothing else, so an ordinary slot or profile write can commit between the offer read and the INSERT.
The row is then sealed against an offer that has already moved; dispatch fail-closes it, but the
manager has been told "queued" and `invited_at` is stamped. Closing it means the product's own
writers take the same lock — a cross-cutting change well outside this batch.

## Review round 5 — FINAL ROUND CONSUMED, NOT CLEAR

All five authorized review rounds are spent and findings remain, so `STOP_RULE` applies: the batch
stops here for an owner decision. **Seven P1, two P2 and one P3 are open.** They are recorded in
full because the shape of them matters more than the count.

**The open P1s**

1. **The rendered-slot binding is optional, so it is bypassable.** The check fires only when
   `d7_rendered_slot_id` is present, and the test helper omits it everywhere except the one test
   written for it — so most of the suite proves the bypass rather than the rule. A `service_role`
   caller that omits the field gets the old behaviour. *This is a hole introduced by the round-4
   correction itself, and the conditional was written that way so existing tests would keep passing,
   which is exactly the wrong reason.*
2. **`offer_fp` does not cover what the email promises.** It digests slot id, start, end and price.
   The message also states the series count and date range, the response deadline, the cycle start
   and the payment mode — all of which can change after enqueue with the fingerprint unmoved.
3. **The claim token and the group are not part of dispatch identity.** Rotating `claim_token` sends
   a dead link; repointing `rebook_group_id` sends the old series description while the token acts on
   the new group.
4. **Invitations are gated by the member window, not their own priority deadline.** `begin_dispatch`
   uses `member_window_ends_at`, while claiming is refused after `availability_slots.priority_window_ends_at` —
   so an invitation can be sent that is already dead on arrival.
5. **Channel-kill deferrals can still cross the cutoff and recycle forever.** Round 4's window guard
   wraps only the quiet-hours branch; the kill branch always schedules `now + 15 minutes`.
6. **The advisory lock is taken after the authoritative claim read**, so a claim that moves during
   the enqueue is still written under the stale tenant — one row, wrong owner, and the correct tenant
   permanently blocked.
7. **The current slot and the captured round can disagree at birth.** A claim captured for R1/S1 and
   moved to same-academy S2 (belonging to R2) before rendering produces a row attributed to R1 whose
   token acts on S2/R2.

**The open P2s and P3** — `zero_send` is counted correctly in the edge loop but two consumers still
mishandle it (the invite-all button reports "already invited"; the drain denominator omits it); the
direct invitation buttons still say "Invitation sent" for what is now only a durable enqueue, so this
runbook's earlier claim that *every* affected surface moved to "queued" was too broad; and the offer
fingerprint renders `timestamptz` through the session `TimeZone`, so a timezone change between
enqueue and dispatch would hold a legitimate invitation.

**What the reviewer confirmed closed** — begin-time round re-resolution and the no-capture false
hold; the quiet-hours/member-window deferral loop; concurrent enqueues against stable claim facts;
the inverted sendable classification; the claim index; the capture tie-break; the structural
soundness of the replaced resolver branch; member-open isolation; ACL, entrypoint count, zero
service-role outbox DML, subject-FK absence, and header/address injection.

**Containment as it stands.** Local, uncommitted, unpushed, undeployed; all D7 schedules inactive and
`rebook_member_open_send_enabled` false, so none of the open paths can produce a provider send today.
The reviewer's own verdict is that this containment postpones rather than closes them: queued rows
would exercise these paths the moment a worker is activated.

## What the manager is now told — the `ROUND2` delivery-presentation item

Cutting the sender over changed what `invited_at` MEANS. It used to be stamped after a confirmed
provider call; it is now stamped after a durable ENQUEUE. Nothing downstream is delivered until the
D7 worker runs, and **all D7 schedules are inactive** — so every surface that said an invitation was
*sent* was, from the moment of the cutover, telling the manager something untrue.

That is a silent semantic change, and it is the kind this project's tokens forbid, so the copy moved
with the behaviour rather than after it:

| Surface | Was | Is |
|---|---|---|
| Round manage badge | "sent" / "verstuurd" | "queued" / "in wachtrij" |
| Badge tooltip | "Invitation sent" | "Invitation queued for delivery" |
| Wizard success | "{{invites}} emails" | "{{invites}} emails queued" |
| Wizard partial | "{{sent}} of {{total}} invitations sent" | "… invitations queued" |
| Progress chip | "{{sent}}/{{total}} sent" | "{{sent}}/{{total}} queued" |

"Queued" is the honest word in BOTH states, which is why it was chosen over anything conditional on
activation: the database never learns that a message was delivered, only that a dispatch was
accepted, so a surface reading `invited_at` can never truthfully say "sent" whatever the schedules
are doing.

**Still open, and deliberately not invented here.** `ODD`'s operator-facing *mark-resolved* control
for an `acceptance_uncertain` row has no surface yet. It cannot be reached today — no dispatch can
happen with the schedules inactive, so no row can enter that state — and building it needs an
operator RPC, which would be a tenth machine entrypoint. It is named here rather than quietly
skipped.

## Tier 4's future-base collision — `20261203300000`

The round-2 finding, recovered verbatim from the review sessions rather than guessed at:

> Tier 4 can still collide with a future, otherwise-unique base. `v_dup` is fixed before iteration
> and `v_emit` contains only earlier decisions. For ordered tier-3 names `A,A,B`, where
> `B = left(A,297) || ' #2'`, the output is `A,B,B`: the second A cannot see future B, and B has
> count one so is never rewritten. The frozen distinct-name verdict then refuses the cohort as
> `invalid_request` although `#3` is available.

Both sets tier 4 avoided looked BACKWARDS. The full tier-3 array is known before the loop, so the
missing set is simply that array; the candidate now avoids it too, except for the base it is
disambiguating from. The regression test reproduces the finding's own fixture — a 200-character
label, Wednesday 09:00, trainer `T`, two 82-character locations and a third of `A`×79 + ` #2`, which
makes every tier-3 name exactly 300 characters.

## What review round 1 found, and what changed

An independent `gpt-5.6-sol` read-only pass returned six P1s. All six were real.

| # | Finding | Fix |
|---|---|---|
| P1 | `apply_eligibility` was decoded and then discarded, arming a send that could only fail | Decoded, and a non-`eligible` verdict becomes `not_permitted` — see blocker 1 |
| P1 | The Academy wizard's advertised blank-end-date flow could not work: no end date and no `weeks` means the core refuses before it can suggest a length | The length is now the manager's explicit choice on both wizards, and the suggestion is displayed rather than substituted |
| P1 | Extend sent no `expectedVersion` — and could not have worked even with one | See blocker 2 |
| P1 | The projection named EVERY qualifying series while the core names only the INCLUDED ones, so excluding one series made the review promise a name the core would not write — and the apply succeeded | Names are built from the included set, in the core's `child_cycle_id::text COLLATE "C"` order; an excluded series has no name |
| P1 | A `review` is several statements under READ COMMITTED, so the projection and the fingerprint could describe different product states | The digest now covers the template facts, the label and the taken names — it does not make the read atomic, it makes it FAIL CLOSED |
| P1 | A committed command could not be replayed: applying CREATES same-date cycles, which changes the taken names, which changes the digest — so the retry was refused `selection_moved` before reaching the stored receipt | A command already committed by this actor under this exact fingerprint goes straight to the core |

Plus the P2s worth naming: `x = ANY(array containing NULL)` is tri-valued and could submit an empty
source set while displaying everything as included; the source must be a real `type='cyclus'` cycle
of the academy, as the legacy producer required; the modal price is the mode over SLOTS; `counts`
reports the included child count; the apply decoder is strict rather than fail-open; the command
uuid survives an ambiguous apply; decimal money is no longer rounded to zero; and a changed
selection drops its digest instead of guaranteeing itself a `selection_moved`.

**One digest formula, not two.** The preview and the apply each computed it inline, and the moment
the preview's was widened they disagreed — every send answered `selection_moved` against a digest
the preview had just issued. `d7_p_selection_digest` is now the only place it is computed.

## What review round 2 found, and what changed

A second independent `gpt-5.6-sol` pass on the round-1 bytes returned five P1s. All five were real,
and the first was introduced BY a round-1 fix.

| # | Finding | Fix |
|---|---|---|
| P1 | `md5(round‖key)::uuid` is a legal uuid VALUE and not a legal v4 — 186 of 200 derived child ids failed the browser's own version/variant check, so round-1's new strict decoder turned nearly every SUCCESSFUL apply into `unknown` and drained no invitations | `d7_child_cycle_id` forces the version and variant nibbles; one derivation, used by both surfaces |
| P1 | The cohort auto-count carries no label, the review does — and round-1 had put the label IN the digest, so the first review after every count was a guaranteed `selection_moved` | The label is out of the digest (it is the operator's own field, already covered by the body revision); the round's taken names stay, because those are the SERVER's state |
| P1 | The blank-end-date flow the screen advertises could not work, and the runbook claimed a fix that had never been written | The wizard now asks the COUNTING projection, which can answer without a length, and fills the field in for the operator to confirm — displayed, never substituted |
| P1 | Extend was sent and its refusal labelled from the outside; the real answer is `invalid_request` (the null version fence), which rendered as "there is nothing to rebook", and the unit test faked the wrong status | An extend is refused by the driver WITHOUT asking, because it cannot succeed; the test now asserts no review is ever attempted |
| P1 | The deploy order still merged the browser before installing its RPCs and claimed the wizards were on the legacy path — following it would have broken rebooking until step 4 | Migrations move to step 1, with the reason stated |

P2s fixed: an unreadable apply status is `unknown` rather than "proof nothing was written", and the
receipt must name the command we sent; the apply-ineligible review STAYS on screen (withholding the
send is not withholding the information); `players` is the review's distinct cohort, not the apply's
`claim_count` — forty claims is five people across eight sessions; the command uuid reaches the
operator's screen as data.

P3 fixed, and worth naming because it invalidated more than itself: the wizard fixture's source id
was `cyc-src`, which the driver rejects as a uuid — so **every test that claimed to exercise a source
cycle was exercising the cohort path with no locations**, and passing. The fixtures now use a real
uuid and state the length explicitly, and one test asserts the mode and the source id directly.

## What review round 3 found, and what changed

Three parallel `gpt-5.6-sol` passes on the round-2 bytes, largely non-overlapping. Two P1s were
defects the round-1 and round-2 fixes had left standing or created.

| # | Finding | Fix |
|---|---|---|
| P1 | The review never showed the server-derived child name: the Academy wizard displayed the typed label, the cohort one showed the list only above two cycles. Fixing the derivation and fingerprinting it made the WRONG name stable, not visible | Both wizards display the names the server returned; the cohort list shows from one cycle up |
| P1 | Trainer and location display names were not in the digest, so a rename between the wrapper's read and the core's produced a review showing the old name beside a fingerprint for the new one — which then applied | Display names are digested |
| P1 | The projection returned untruncated names while both cores `sanitize_copy(…, 300)` and fingerprint the truncated value | The projection truncates identically |
| P1 | A recognised refusal carrying ANOTHER command's id was accepted as proof our command wrote nothing | The receipt is bound to our command uuid BEFORE its status is read |
| P1 | The deploy sequence contradicted the file's own producer-quiescence requirement and its executor contract | Both restated at the head of the sequence; ABC-27 keeps its `psql --single-transaction` executor and its `schema_migrations` note |

P2s fixed: `APPLY_REFUSALS` was hand-written and wrong in both directions — it is now derived from
`ROUND_COMMAND_STATUSES`, the vocabulary the repo already shared, with the three command-identity
mismatches deliberately EXCLUDED from "proof nothing was written" (when we presented our own uuid, a
payload mismatch is evidence a command under it committed); the cohort wizard now keeps its review
when the send is withheld, which matters because its count prefills the source price and so
`refused_session_price` is its ORDINARY path; a receipt claiming zero claims for an approved cohort
is a contradiction rather than a quiet success; the blank-end-date count is guarded on the live body
revision, not only on the click generation; duration is an epoch difference that cannot overflow and
is NULL rather than rounded when it is not a whole minute; and same-date taken names include DRAFTS,
because `uniq_rebook_cycle_key` does.

P3s fixed, and both mattered: the extend test never reached the review, so deleting the fix entirely
left it green; the blank-end-date test never asserted the field was filled, so a wizard that counted
forever would have passed. Both were mutation-verified after the change — removing each fix now
fails its test.

### A THIRD OWNER DECISION, surfaced by round 3

Extend is refused client-side for EVERY round, not only pre-cutover ones, and the reason is sharper
than previously recorded: the core's expected-version fence is mandatory and **no client role can
read the version**. `rebook_rounds` carries `REVOKE ALL … FROM PUBLIC, anon, authenticated,
service_role` with RLS enabled and zero policies, and no operator wrapper returns a version except
the apply receipt — which only the caller that just applied ever sees.

There is a clean fix that needs no new privilege: the A-owned selection wrapper **can** read
`rebook_rounds` and could resolve the version itself, which would make extend work for rounds this
cutover creates. That is a capability decision, so it is recorded rather than taken.

## What review round 4 found, and what changed

Seven P1s on the round-3 bytes. The uncomfortable ones were about the EVIDENCE rather than the code:
two fixtures described answers the surface cannot send, and until they were made faithful the tests
could not have caught the defects beside them.

| # | Finding | Fix |
|---|---|---|
| P1 | A target-bearing `review` could be answered without echoing a digest, so an armable review could straddle two observations — €25 on screen, €30 in the fingerprint, €30 written | The wrapper refuses a target-bearing review with no `p_selection_digest`; probe and `counts` stay digest-free because neither can arm anything |
| P1 | The digest's serialization was not injective: `{X, z}` and `{X\u0001z}` produced identical bytes | Every element is length-prefixed |
| P1 | A PostgREST row cap truncates a large answer into one that still looks well formed — same result row, shorter roster — while the apply creates claims for everyone | The client reconciles the rowset against the counts the result row states |
| P1 | The review fingerprint was accepted as any non-empty string; the repo already ships an exact 32-octet validator | `readReviewFingerprint` validates it |
| P1 | An eligible review immediately prefilled the source price into live state, making itself stale AND apply-ineligible; re-reviewing refilled it. The round was never sendable | The prefill is removed from both wizards; the recommendation is still shown beside the field |
| P1 | Duration was not bounded as the core bounds it | NULL unless a whole number of minutes in (0, 1440] |
| P1 | The ACL matrix listed the bridges by hand, so a new one could be omitted | Derived from the catalog |

The runbook was wrong in two ways that would have reached production: the migration table omitted
`20261118115500`, which ABC-27's own preflight requires, and the sequence lifted the producer pause
without ever undeploying `bulk-rebook-cycle` — merging stops the current bundle, not a tab loaded an
hour earlier.

## What review round 5 found, and what changed — the final round

Four parallel `gpt-5.6-sol` passes on the round-4 bytes. They converged hard, and the pattern of the
whole loop repeated once more: **the largest finding of the round was a defect introduced by the
previous round's fix.**

| # | Finding | Fix |
|---|---|---|
| P1 | Round 4's reconciliation keyed on `(series_key, display_name)`, but the server counts recipient KEYS and two people may share a name — two "Jan de Vries", or two nameless players both rendered `—`. A legitimate cohort was declared unreadable and could not be sent by either wizard | Reconciled on the ROW COUNT, exactly and per series; a name is not an identity |
| P1 | Round 4 skipped its check entirely when the roster was empty — the shape a row cap most likely produces, since the result and series rows come first and are few. `child_count` still agreed and the operator armed a send having been shown nobody | A `review` always carries its roster; an empty one is not a valid answer |
| P1 | The invitation count subtracted two incommensurable quantities: `cohort_total` counts a person once across the round, `no_email_total` sums per series. A player in two included groups was offered as "send 1 invitation" and mailed twice | The count is summed per included series — what the drain will actually produce |
| P1 | The documented step 1 could not be executed: `supabase db push` has no version cutoff, so "push up to `20261118115500`" runs ABC-27 under the forbidden executor | The three leading files are applied and recorded by hand; only the remainder is pushed, after reading `--dry-run` |

P2s fixed: both confirmation headlines substituted a single modal recommendation while a blank price
field means each series keeps its OWN — and blank is the only path that can reach a send, so the
sendable case was exactly the wrong one; the headline headcount was copied without checking it can
coexist with the per-series counts beside it (it can be neither more than their sum nor less than
the largest single one); and a typed override was stated as a row's price while that row's total was
computed from the template.

P3s fixed, and two of them mattered more than their severity suggests. The wizard suite's apply fake
returned a FIXED command uuid while the wizard mints a random one per send, so the driver rejected
every scripted apply and each "nominal" case silently exercised the `unknown` branch — no wizard test
had ever reached a created round. Worse, `createAndDrainRebookRound` calls its own internal binding,
so replacing the module export never intercepted it: **every `expect(drainMock).not.toHaveBeenCalled()`
in that file was vacuously true.** Both are fixed by injecting the dependency, which turns roughly six
dead assertions into live ones, and two success-path tests now prove drain and navigation directly.
Also: the ACL matrix collapsed overloads by name and now keys on the signature (proved against an
overload created and rolled back inside the test); the long-name parity test used a 320-character
label the core refuses, so it never compared against a storable name, and now asserts the refusal at
201 and real projection/apply parity at 200; and the price-prefill removal, previously untested,
now has a regression case in both wizards.

### What round 5 raised that was not fixed in that round — ALL FOUR NOW CLOSED

These four landed on the selection-authority migrations, which round 5's authority declared complete
and not to be amended, so they were recorded for the owner rather than patched. All four are closed
by the terminal semantics closure below (`20261203220000`, `20261203230000`), which supersedes those
files rather than amending them:

1. **Roster identity and contact facts are bound to neither the digest nor the fingerprint** (all
   four passes, independently). The roster reads `display_name`/`has_email` live, and delivery
   resolves contacts live again. A recipient reviewed as "no email" who gains one before the drain
   is emailed anyway; one who loses an address is silently skipped. This is the round's most
   significant finding and the digest is where it would be closed.
2. **Name disambiguation runs before the 300-character truncation**, so two candidates distinct at
   full length can be identical after it — refusing a valid cohort, or arming a review whose apply
   must fail on `uniq_rebook_cycle_key`.
3. **A trailing-whitespace label is projected raw but written trimmed**, so a direct RPC caller can
   review one name and successfully write another. The shipped wizards trim, so the browser path is
   unaffected.
4. **A zero-occurrence intent previews as `previewed` but applies into a raw `22023`**, outside the
   typed vocabulary. The browser refuses it first; a direct RPC caller does not.

Two display quirks were also confirmed as faithful ports of legacy behaviour rather than
regressions. The first — the cohort summary labelling participant-sessions "sessions" while the
other wizard showed court sessions — is closed by OD6 below: both quantities are now named for what
they are. The second stands: the modal-price recommendation breaks ties differently from the legacy
`mode()`, which is advisory only now that the price is never prefilled.

## The terminal semantics closure — `20261203220000` … `20261203230000`

Authorised by `APPROVE_D7_RUNTIME_TERMINAL_SEMANTICS_AND_RECOVERY_CLOSURE_V1`. It closes the four
findings review round 5 raised against the selection authority, plus the two capabilities the
cutover left stranded.

### Why two migrations and not three

The plan proposed three. `d7_p_selection_digest` gains a parameter, and in PostgreSQL a
`CREATE OR REPLACE FUNCTION` with a new parameter list creates an **overload** rather than replacing
— so a migration boundary between the preview's move to the nine-argument digest and the apply's
would leave the two surfaces computing DIFFERENT digests, and every apply in between would answer
`selection_moved` against a digest the preview had just issued. That is the round-1 defect the
shared digest function was introduced to fix; a migration boundary is no safer a place to split it
than two inline copies were. **Everything that must change together is in one transaction.**

### What each one does

**`20261203220000` — naming on the persisted form.** The chain decided collisions on untruncated
candidates while both callers truncated to 300 afterwards, so it was answering a question about
strings nobody stores. It failed in both directions: a valid cohort refused because two names became
identical after truncation, and an armed review whose apply had to die on `uniq_rebook_cycle_key`.
Every tier now ends in the persisted form, and tier 4 cuts the base to `300 - length(' #' || k)`
BEFORE appending its suffix — otherwise the numeric tier, whose entire job is breaking ties, hands
back the name it was disambiguating from.

**`20261203230000` — the semantics closure.** One boundary label normalization
(`rebook_round_sanitize_copy(·, 201)`, the cores' own expression and constant — 201 is max+1 so a
201-character label FAILS `rebook_rounds`' `length(label) <= 200` CHECK instead of being silently
truncated into a legal 200); a typed zero-occurrence refusal that issues **no fingerprint and no
digest**, so nothing armable exists for an empty round; the round version for `extend`; and the
contact snapshot timestamp.

### The three owner decisions this encodes

**OD1/OD2 · contacts are mutable attributes, disclosed — not frozen.** The roster's display names
and email presence are bound to neither the selection digest nor the command fingerprint, and they
are deliberately still not. Freezing them would expire a review whenever any recipient edited their
own email, producing `selection_moved` on a routine profile edit and training operators to
re-review reflexively — which would destroy the `selection_moved` signal round 5 worked to make
meaningful. Instead: the review states WHEN its snapshot was taken, the apply returns the contact
counts it saw when it wrote the round, and the wizard says so out loud when they differ from what
the operator approved. Delivery continues to resolve current authorized contacts.

Preview and delivery use the SAME contact predicate, which is worth recording because it was
initially suspected otherwise: `d7_p_subject_display` reads `NULLIF(btrim(email),'')` and
`resolve_guest_member_contacts` returns exactly that as `own_email`, with the account arm
deliberately removed. The gap was only ever one of TIME, never of rule.

**OD3 · the round version is disclosed, academy-scoped.** Extend was refused client-side because the
core's `expected_version` fence is mandatory and `rebook_rounds` is revoked from every client role
with RLS on and zero policies. The Domain-A-owned preview wrapper reads it and returns it — **no new
grant, no new table exposure**: one integer about the caller's own round, through a wrapper they
could already call. The fence is unweakened; this is ordinary optimistic concurrency, and the
version is digested too so `selection_moved` arrives before `expected_version_mismatch`.

**OD4 · session price stays refused.** Nothing here touches it. The refusal is structural — a CHECK
on `rebook_round_intent_policies` ties `apply_eligibility` to `session_price` — and ABC-27's own
column comment records why: *"the money precedence/total_price rule is a separate owner decision"*.
Opening it needs that rule AND a constraint change on a frozen-file table.

**OD6 · both session quantities are named.** `total_sessions` is sessions × players — participant
sessions, matching legacy `bulk-rebook-cycle:740` — while the table's own rows sum court sessions.
Both were rendered as "sessies", and the two wizards showed different ones. They now say which is
which.

## Lost apply responses are recoverable, and always were

The most consequential finding of this batch is that **nothing new was needed.**
`rebook_round_command_status_as_actor` and `rebook_round_command_lookup_by_review_as_actor` are
installed by frozen ABC-27 and were already granted to `authenticated`; `rebook_round_commands`
freezes the exact receipt bytes with a SHA-256 over them, tied together by CHECK constraints so a
row cannot disagree with itself; and `src/lib/rebookRoundDriver.ts` has implemented the two-stage
lookup since the command-driver work. The cutover routed both wizards through a driver that had no
recovery path, so all of it sat unused.

The apply's own duplicate-intent refusal had been saying what to do the whole time — *"this actor
already applied this exact reviewed intent under another command UUID; recover it by review
fingerprint"* — and the browser ignored it, reporting `creation_failed` for a round that HAD been
created and inviting the operator to make a second one.

**How it now behaves.** An unreadable apply, or an `invalid_request` that may be the duplicate-intent
refusal, asks the ledger: by command uuid first, then by reviewed fingerprint. A found receipt is
verified — SHA-256 over the canonical bytes, then the round and command ids it claims — and the
round is drained exactly as an acknowledged one is. Both wrappers are `STABLE` and actor-scoped, so
recovery **cannot mint, write or send**; that is structural, not a promise. Re-draining is safe
because the sender selects only `status = 'pending'` claims, so a claim already invited is not
invited again — a property of the data model rather than of the client.

When BOTH handles refuse, nothing was written and the operator is told they can safely start again.
When the ledger cannot be read, they are told that instead, in weaker words, because it is a weaker
statement.

## A recovered round is reported, never re-sent

`D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`. Raised as a release blocker against the closure's first
implementation, which drained a recovered round automatically.

**There is no durable no-duplicate authority for this sender, and that is the whole finding.** A
provider send is recorded in exactly one place — `slot_priority_claims.invited_at` — and the sender
is deliberately SEND-THEN-STAMP: it calls Resend first with a deterministic key
(`priority-claim-invite:{claim_id}`), then stamps only a confirmed send. That ordering is right; it
is what stops a failed send from suppressing a claim forever. But it means an UNSTAMPED claim is
genuinely ambiguous: never sent, or sent with a stamp that failed. The sender already names that
third outcome `unresolved`, counts it, alerts on it, and the in-request drain loop deliberately
stops rather than looping to re-send it.

The only thing preventing a duplicate across attempts is the provider's own idempotency key, which
Resend honours for **24 hours**. That is a provider contract with a time bound, not a durable
authority — and a round recovered a day later is outside it. This sender does not participate in the
N-series `notification_outbox` / provider-event ledger, so nothing else records the attempt.

**So the closure fails closed.** Three paths can reach a round an earlier attempt may already have
mailed — the server answering `replayed`, a lost response resolved from the command ledger, and the
duplicate-intent refusal pointing at another command uuid — and none of them sends anything. They
resolve the round, name it, and hand the operator a persistent reconciliation notice: the round
exists, nothing was sent just now, an earlier attempt may have mailed some players, open the round
to see who has been invited and send the rest from there. Resuming stays available and stays
EXPLICIT.

The control that keeps this from being satisfied by never sending at all: a first, acknowledged
apply still drains. A round this call just created cannot carry a prior provider effect, because no
earlier command committed it.

**What would close it properly** — and what it would cost — is recorded here rather than taken,
because it needs a persisted schema fact and this authority's `STOP_RULE` reserves that: a durable
per-claim send-attempt record written BEFORE the provider call and completed after it, so an
unstamped claim can be told apart from an unattempted one. That is the same shape as the N-series
outbox, and adopting it for this sender is an owner decision.

## The two activation gates, and why there are two

They are independent on purpose, so a mistake in either one cannot send anything:

- **The schedules.** `cron.alter_job(jobid, active := true)`, per job. The janitor and the
  materializer make no provider call at all, so they can be armed first and observed; with the
  dispatcher's flag still absent, the rows the materializer writes sit unsent in the outbox — which
  is the state worth inspecting before anything is sent.
- **The dispatcher's send flag.** `REBOOK_MEMBER_OPEN_SEND_ENABLED` is an edge environment variable,
  absent by default, and `=== "true"` is the only arm that enables it. `TRUE`, `1`, `yes` and
  `" true"` are all OFF, which is asserted.

The flag gates the **whole dispatcher**, not just the provider call. Gating only the `fetch` would
still claim rows, burn lease generations and leave them leased for the janitor to recover — strictly
worse than a clean no-op.

## The `CREATE INDEX` lock, and when to do it by hand instead

`20261203110000` creates one partial index on `notification_outbox`:

Quoted verbatim from the migration — this is not a statement to run by hand:

```
CREATE INDEX IF NOT EXISTS idx_notification_outbox_d7_member_open_claim
  ON public.notification_outbox (scheduled_for, id)
  WHERE event_type = 'rebook_member_open_player'
    AND channel    = 'email'
    AND transport_state IN ('queued','retry_wait','quiet_hours_deferred','channel_kill_deferred');
```

(The DDL blocks in this section are deliberately NOT tagged `sql`. Every `sql`-tagged fence in this
document is swept for schema qualification, because the preflight and census queries above are
pasted into an operator's own session where `search_path` is not controlled. These two are
different: one is a quotation of text the MIGRATION runs under a controlled path, and the other is
a `CREATE INDEX` whose predicate must stay textually identical to it. Qualifying either would
misrepresent the migration. The one query here that an operator really does paste — the size read —
is `sql`-tagged and fully qualified.)

`CREATE INDEX` takes a `SHARE` lock, which blocks writes to `notification_outbox` for the build —
and that stalls the every-two-minutes `notification-email-worker`. The predicate matches **zero**
rows at apply time, because D7 has never run, so the build is a single scan over an empty match set.

Take this reading first:

```sql
SELECT pg_catalog.pg_size_pretty(pg_catalog.pg_relation_size('public.notification_outbox'::pg_catalog.regclass)) AS size,
       (SELECT c.reltuples::pg_catalog.bigint
          FROM pg_catalog.pg_class c
         WHERE c.oid OPERATOR(pg_catalog.=) 'public.notification_outbox'::pg_catalog.regclass) AS est_rows;
```

If the table is large enough that a `SHARE` lock is not acceptable, create the index **by hand,
outside the migration**, before applying it:

```
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_outbox_d7_member_open_claim
  ON public.notification_outbox (scheduled_for, id)
  WHERE event_type = 'rebook_member_open_player'
    AND channel    = 'email'
    AND transport_state IN ('queued','retry_wait','quiet_hours_deferred','channel_kill_deferred');
```

Run it in a session whose `search_path` you control — the predicate is deliberately byte-identical
to the migration's, so it must not be rewritten into qualified operator form here.

The migration's `IF NOT EXISTS` then finds it already there. `CONCURRENTLY` **cannot** run inside a
transaction block, which is why it can never be done from the migration itself.

## Measured performance (embedded PostgreSQL 18, `src/test/d7Performance.realpg.test.ts`)

Buffer counts are the ROOT plan node's, which is already inclusive of its children — summing every
node's line double-counts each level and overstates the cost. Timings move a little run to run with
cache state; the figures that matter — whether the index is chosen, whether a `Sort` node appears,
and the order-of-magnitude difference — do not, and they are what the suite asserts.

| Measurement | Result |
|---|---|
| One full 2 000-recipient materialize page | 2 000 considered, 2 000 written, ~1–2 s |
| Claim scan @ 2 000 resident D7 rows, with the index | index chosen, **no Sort**, ~20 shared buffers |
| …without the index | **Sort** planned, ~4 500 shared buffers |
| Claim scan @ 8 000 resident D7 rows, with the index | index chosen, **no Sort**, ~20 shared buffers |
| …without the index | **Sort** planned, ~18 000 shared buffers |
| Recovery scan @ 8 000 | **not** served by the claim index (accepted residual) |
| Close scan @ 8 000 | **not** served by the claim index (accepted residual) |
| `notification_outbox` size / index size / index rebuild at 8 000 rows | 4.0 MB / 96 kB / ~2–15 ms |

At 8 000 resident rows the index turns an ~18 000-buffer sorted scan into a ~20-buffer ordered one —
roughly a 900x reduction in buffers touched — and the `LIMIT 8` terminates it early rather than
reading the whole match set.

**The paid-group hold's own cost (P-7).** It is a correlated `NOT EXISTS` evaluated once per
candidate court, entering `slot_priority_claims` by `slot_id` and `invoices` by `rebook_group_id`.
Measured on the shape production actually has — two series of 100 courts x 4 cohort with **one group
id per series** (which is how both create paths mint them), one series paid and one not, against a
50 002-row `invoices` table — it uses the partial unique `uq_invoices_active_rebook_group`, never
sequentially scans either relation, and costs ~34 shared buffers / ~0.33 ms for 200 courts. (Against
a near-empty `invoices` table the planner correctly sequentially scans it instead; that is the
planner being right, not a missing index, and the measurement records both readings.)

**And the composed whole-round cost — TWO factors, each measured at its own ceiling.** Arm (4) asks,
for each recipient and each cycle its immutable provenance names, whether any slot of that cycle
still has a free seat and is unheld. The work is therefore
`recipients x courts-in-that-cycle x one per-court probe`, and the product's ceilings for a child
series are **200 cohort** and **400 slots**. Each factor is measured with the other held down, and
neither measurement is offered as a bound on the other:

| Measurement | Shape | Unpaid group | Paid group |
|---|---|---|---|
| **P-7b** — the cohort factor | 2 000 recipients on **one** court, 2 000-claim cohort (10x the 200 ceiling), 50 k invoices | ~0.9 s | ~1.1 s |
| **P-7c** — the court factor | **320 courts x 200 cohort = 64 000 claims**, derived from the shipped ceilings, 50 k invoices | ~0.03 s | **~2.7 s** |
| **P-7d** — both factors, correlated | **40 provenance cycles x 200 courts, all 200 recipients in EVERY cycle** = 8 000 sources and 8 000 courts, both on their shipped ceilings | **~27 s** | ~14 s |

In both tables the two columns differ only in one invoice's status, so the gap between them is the
hold firing and nothing else.

**The P-7c fixture sits ON the shipped limit, and the limit is read from the database.** The apply
refuses to create more than `rebook_round_max_pending_claims()` = 64 000 pending claims for a child,
and `rebook_round_max_cohort_per_child()` = 200 caps the cohort — so the largest court count a single
child can reach is 320, and the test derives `320` rather than asserting it. **An earlier revision
used 400 x 200 = 80 000 and called it "the largest round the product can produce"; that was false,
because the apply refuses it.** The number is retracted and replaced above.

**P-7d is the binding measurement, and it is the one to watch.** Arm (4) iterates recipient x
*provenance cycle* pairs and scans every court of each cycle, so the cost is a PRODUCT — and P-7b and
P-7c each pin one of its two factors at one. P-7d pins neither: the freeze bounds captured claim
sources at 8 000, and spreading those as "the same 200 recipients appearing in all 40 cycles" is a
far heavier judgement than one source per recipient. **~27 s against the materializer's 60 s RPC
timeout — a margin of roughly 2.2x, and the tightest number in this document.** Both arms are
asserted against that timeout in `src/test/d7Performance.realpg.test.ts`.

**Which arm is expensive depends on the shape, not on the hold.** A linear projection from P-7c
predicted ~68 s for P-7d's paid arm, past the timeout; measuring it gave a very different answer.
**An earlier revision of this document explained that by saying the all-held scan "ends early". That
was wrong** — the outer `EXISTS` over courts must exhaust every court before it can conclude there is
no free seat, and only the inner per-court lookup short-circuits. What actually made the paid arm
cheap is the inner lookup: it finds a held court on its first probe, where the unpaid arm reads the
court's whole booking set to conclude nothing holds it.

**Why the paid arm is a hundred times slower at P-7c.** When the captain has paid, EVERY court in the cycle
is held, so the `EXISTS` over slots can never short-circuit: it walks all 320 courts for all 200
recipients and probes each one's 200-claim cohort. The unpaid arm stops at the first unheld court.
Both sit inside one materializer page, which is budgeted in seconds and bounded by
`MATERIALIZER_MAX_RECIPIENTS = 500` — and a page may span more than one child, with cost linear in
the recipient count, which is the dimension P-7b measures. The freeze separately refuses a round
carrying more than `rebook_round_max_claim_sources()` = 8 000 captured claim sources.

**⭐ P-8 IS THE BOUND. Everything else on this page is a factor of it.**

The runtime does not run an eligibility query; it runs `rebook_round_materialize(3, 500)` inside one
transaction under a 60-second RPC timeout, and the owner's budget for that complete unit is
**30 seconds**. P-8 measures exactly that call, at the shipped batch size, over three adverse rounds
at the worst legal shape — 24 000 courts, 24 000 claim sources, 600 recipients, **every court held**
— including freeze, judgement, decision writes, enqueue and result encoding:

| Batch size | Rounds | Courts | Sources | Recipients | Complete transaction |
|---|---|---|---|---|---|
| **3 (shipped)** | 3 | 24 000 | 24 000 | 600 | **284 ms** |
| 2 | 2 | 16 000 | 16 000 | 400 | 171 ms |
| 1 | 1 | 8 000 | 8 000 | 200 | 81 ms |

**284 ms against a 30 000 ms budget — a margin of about 105x, and no batch-size reduction is
needed.** Each size is measured on its own clone, because materializing a round consumes it and a
second measurement in the same database would be reading leftovers. An earlier revision of this
document quoted a single-round eligibility query against the RPC timeout; that was the wrong unit and
is superseded by the table above.

The booking-anchored hold is also what made this cheap: the retired claim/invoice predicate joined
two relations per court, where the current one is a single indexed lookup on `bookings.slot_id`.

**What the linearization closure adds to the dispatch path (P-7c, same fixture).** `begin_dispatch`
now performs ONE single-recipient judgement of the same authority before it authorizes. Measured on
the ceiling-shaped fixture that is **~8 ms** with the group unpaid and **~24 ms** with it paid.
The dispatcher admits at most `claimLimit = 8` rows per invocation, so the whole per-invocation
addition is ~0.08–0.22 s, each instance inside that row's existing 10 s RPC timeout. **The
worst-case invocation arithmetic below is unchanged** — the re-read happens inside `begin_dispatch`,
which is already one of the three per-row RPCs that arithmetic counts.

**What P-7c is and is not.** Its claim population is derived from the shipped apply ceilings, but the
snapshot it judges is written directly rather than produced by the freeze — the freeze captures every
claim in the sibling cycles and would refuse that many. It is therefore a court-factor stress
measurement, not a product-reachable frozen round; P-7d is the one whose *sources* sit on the freeze
ceiling. The test says so in the same words.

**What no catalog evidence can prove, stated rather than implied.** The suite proves what the
post-ABC-27 files leave behind (catalog comparisons), that they write no row (a statement-level
witness), and exactly which statements they execute (an event-trigger census of nine actions). It
cannot prove the absence of a *transient external* effect that leaves nothing behind:
`pg_notify` delivers to listeners and vanishes, and `COPY … PROGRAM` runs outside the database
entirely. Outbound HTTP is covered only because the evidence harness's `pg_net` shim queues into a
real table that the witness watches — so a migration posting outbox contents anywhere shows up as an
INSERT. The remaining transient channels are a disclosed limit of the method, not a checked one.

**Nothing here is described as a "conservative upper bound".** An earlier revision of this document
used that phrase for P-7b alone, which pinned the court factor at its minimum of one — the reading
it was least entitled to make.

Worst-case dispatcher invocation, with every bound at its ceiling: `10 s` claim + `25 s` budget +
`3 × 10 s` per-row RPCs + `20 s` provider call = **85 s**, against a 15-minute (900 s) stale-lease
threshold. A healthy invocation can never have its own leases recovered underneath it.

## Recovery, and how D7 differs from the generic worker

- **A stale lease.** The janitor's `rebook_member_open_recover_expired_leases(500, 15)` returns a row
  to its **exact stored origin** when the generation was never authorized, and to
  `acceptance_uncertain` when it was. The asymmetry is the point: returning an authorized-but-
  unanswered row to a sendable origin would authorize a second provider call for a message that may
  already be in flight.
- **An unresolved row.** `rebook_member_open_close_unresolved(200)` decides it honestly —
  `dispatch_unknown` for acceptance-uncertainty past its own write-once deadline,
  `member_window_closed` for a row that can no longer send.
- **A channel kill defers; it does not release.** This differs from the generic email worker. The
  D7 kill path is `pre_dispatch_resolve` returning `deferred`, which parks the row with a bounded
  15-minute re-poll. The generic `release_notification_claims_on_kill` is **not** reachable from the
  D7 worker and it holds no grant for it.
- **A wedged dispatcher cannot block its own repair.** The janitor is a separate function on a
  separate schedule, and it is deliberately not behind the send flag: an inert janitor turns a stale
  lease into a permanent wedge.

## Residuals carried into production

1. **~~PAID-GROUP NON-CONTAINMENT (RP-3 / L-7)~~ — CLOSED by `20261203120000`.** The legacy
   `slot_held_by_paid_group` predicate is **slot-level**; ABC-27 shipped only the **cycle-level**
   `upfront` rule, and the gap between them was product-reachable — both create paths stamp a
   `rebook_group_id` on every claim with no reference to the payment mode, and
   `create-rebook-invoice-public` delegates a **solo** group to `create-group-rebook-invoice`
   without a payment-mode gate. On the owner's decision the closure folds the canonical slot-level
   hold into the freed-seat arm and **retains** the cycle-wide `upfront` suppression beside it.

   **`20261203140000` then re-anchored that hold on the BOOKING, and the reason is worth keeping.**
   The first closure derived the hold from a claim joined to a paid invoice. Three measured facts
   defeat that: the shipped guest merge DELETES the claim on a slot collision while repointing the
   invoice, so an ordinary merge released a court somebody had paid for in full;
   `invoices.academy_profile_id` is NULL on rebook invoices (none of the three creating functions
   sets it), so an academy predicate there would have silently disabled the hold everywhere; and
   `invoices.booking_ids` is append-only, so it keeps cancelled bookings for ever. **The hold is now
   a non-cancelled booking on the court with `payment_status = 'paid'` and a captain in
   `paid_by_player_id` / `paid_by_guest_player_id`** — which is where the product already keeps the
   fact, and what `rebook_group_manage` itself reads. Tenant containment is the booking-to-slot join:
   a booking on this court is on this academy's court by construction, with no filter to forget and
   no group UUID whose secrecy has to hold. Stale, cancelled and unpaid records never block a
   release.

   The guarantee it buys, stated exactly: **at every point where this system reads eligibility — the
   materializer, the live pre-dispatch gate, and (since `20261203130000`) the durable
   `begin_dispatch` authorization itself — a court held by a paid group is suppressed, in any
   payment mode.** The last of those three is the **linearization point**; residual 2 states what
   that means and is the only qualification on the sentence above. Proved in
   `src/test/d7RuntimeContract.realpg.test.ts` with
   the adversarial controls (unpaid, absent, foreign group, foreign tenant, non-`pending` holding
   claim, cross-slot, cross-cycle, one recipient across two provenance cycles, and a payment that
   lands AFTER materialization) and slot-for-slot parity against the canonical authority.
2. **~~THE HOLD IS READ ONCE PER DISPATCH~~ — CLOSED by `20261203130000`, to a stated
   LINEARIZATION POINT.** The dispatch path is three transactions and one external call:
   `pre_dispatch_resolve` (reads eligibility) → the worker returns to its own process →
   `begin_dispatch` (authorizes) → `sendOnce`. Eligibility used to be read at step 1 and nowhere
   later, so everything the world did between steps 1 and 3 was invisible to the send that raced it
   — a seat claimed, a decline landing, a sibling closing, or a rebook group captain settling an
   invoice to `paid`.

   `begin_dispatch` now re-reads live eligibility through `abc27_a_live_eligible` — **the same
   authority `pre_dispatch_resolve` uses, with the same two arguments** — inside its own durable
   transaction, after every other fence and before the first durable artifact exists. If eligibility
   has changed, the row is refused with this function's existing refusal semantic (`refused` plus a
   named reason drawn from the unit's own vocabularies: `ineligible`, or `unreadable_policy_state`
   when the authority cannot answer). A refusal writes **nothing** — no grant, no operation row, no
   column — and the worker's exhaustive disposition switch makes **zero** provider calls. The row
   keeps its lease, the janitor returns it to its exact stored origin, and the next resolve writes
   the honest terminal decision.

   **The contract, stated exactly.** The durable `begin_dispatch` transaction is the
   **linearization point** for member-open eligibility. Everything committed before that
   transaction's eligibility observation is seen and honoured. **A payment committed after the
   linearization point does not retroactively invalidate an already-authorized external send** — an
   email that has been authorized and sent cannot be taken back, and nothing in this release
   pretends otherwise.

   **Two things the re-read depends on, both now enforced rather than assumed.**

   - **READ COMMITTED.** The freshness of the observation is a property of the isolation level: under
     `REPEATABLE READ` or `SERIALIZABLE` every statement in the transaction reuses one snapshot, and
     the re-read would faithfully report eligibility as it stood *before* the payment — a stale
     answer that looks exactly like a fresh one. The isolation level is **ambient**: `ALTER ROLE …
     SET default_transaction_isolation` or `ALTER DATABASE … SET …` changes it for every future
     session without touching a line of this function, a grant, or any object a catalog diff
     compares. So `begin_dispatch` reads `current_setting('transaction_isolation')` and **refuses
     fail-closed** if it is not `read committed`. Not sending is recoverable; sending on a read that
     could not see the payment is not. `src/test/d7ForwardChain.realpg.test.ts` also diffs
     `pg_db_role_setting` from a snapshot taken before any of these migrations ran anywhere in the
     cluster, because that catalog is cluster-wide and a per-database diff of it cannot fail.
   - **The member-window deadline is fenced twice.** Before this release the window check *was* the
     last fence, so "judged at the sampled clock" and "judged immediately before authorizing" were
     one instant. The eligibility read now sits between them and takes measurable time — ~8 ms, more
     with a broad provenance — so the clock is re-sampled **after** it and the window and cutoff are
     judged again. The stored `first_dispatch_at` / `uncertainty_deadline_at` pair is **not**
     recomputed: it is immutable by contract, so this is a second fence, never a second derivation.

   **What is left, and why it is left.** The residual is now the interval between the re-read's
   snapshot and that transaction's commit — microseconds, rather than two network round trips and a
   provider call. Driving it to zero would mean taking a lock the payment path must also take, and
   **holding a payment or booking lock across a provider fetch is refused by design**: it converts a
   stale-invitation risk into a deadlock-and-latency risk on the payment path itself. An eligibility
   read and an outbound email cannot be made atomic by anyone. Pinned in
   `src/test/d7ForwardChain.realpg.test.ts` (structure, with the ABC-27 body as the control) and
   proved behaviourally in `src/test/d7RuntimeContract.realpg.test.ts`, which commits a payment in
   the seam between the resolve and the begin and asserts the worker sends nothing.
3. **The one-index decision.** Recovery and close scans are not served by the claim index; they are
   bounded by live D7 row count rather than by batch size. Measured above and accepted; no second
   index is added.
4. **An `upfront` round no longer emits a member-open invitation at all.** A documented product
   narrowing, recorded in `docs/DOMAIN_MODEL.md`.
5. **Rows left leased return only when the janitor recovers them — up to ~25 minutes, not 15.**
   This applies to rows claimed but not started when the dispatcher's wall-clock budget runs out,
   and to a row whose `begin_dispatch` refused. **The arithmetic, stated properly:** a lease is only
   recoverable once it is `staleAfterMinutes` = 15 old, and the janitor ticks every 10 minutes, so
   an unfavourably phased row waits up to 15 + 10 = ~25 minutes for the first qualifying tick, plus
   up to 2 minutes for the next dispatcher tick to pick it up. An earlier revision of this document
   said "up to 15 minutes", which was the threshold rather than the latency. It is never a lost
   message *while the janitor runs*; an inactive or unhealthy janitor wedges the row indefinitely,
   which is why the janitor is a separate function on a separate schedule and deliberately not
   behind the send flag. The dispatcher reports `unprocessed` so the backlog is visible.

   **A refused `begin_dispatch` makes the invocation RED, and that is a deliberate cost.** Every
   begin refusal — including the ordinary, expected `ineligible` race this release introduces —
   becomes a row fault, so the run reports `error`, the endpoint returns HTTP 500 and the Slack
   alert fires. Before this release every begin refusal was a capability or invariant fault, so
   "run red" meant "something is wrong"; it now also means "a payment landed mid-dispatch", which is
   normal. **Operators should expect occasional red invocations whose only row fault is
   `begin_refused` with `refusal_reason = 'ineligible'`, and those are working-as-intended.**
   Distinguishing them is a one-line log filter on `rebook_member_open_worker_begin_refused`.
   Downgrading that arm to a counted non-red outcome would change what a red dispatcher invocation
   means operationally — an owner decision, not taken here.
6. **~~The wizards are not cut over.~~ — SUPERSEDED.** They are, and `bulk-rebook-cycle` is no
   longer a create path at all: nothing in the browser calls it, and the deploy sequence undeploys
   it. This residual was still describing the previous release; leaving it standing beside the new
   sequence was itself a review finding, because a reader following it would have kept the producer
   alive. See "The wizards are cut over" and the two owner decisions above.

---

## The fixture trainer namespace — a SOURCE authority, not an observer

**Test-suite infrastructure only.** Nothing in this section touches a product relation, column,
policy, index, constraint, trigger, grant, role, schedule or timestamp. The frozen migration
`20261118120000_abc27_rebook_round_notification_authority.sql` is byte-exact throughout
(`05e04451f944cabf…`, 20,633 lines), no database object is created and no census exemption is
taken. It is recorded here because the property it protects — that two ABC-27 fixtures never share
one overlap namespace — is what made a suite failure on 2026-08-29 unattributable, and because the
mechanism that was supposed to protect it was reviewed and refused.

### The property, and why it is not incidental

`check_trainer_slot_overlap` is one of the 44 shipped triggers, it is live on this suite's
predecessor, Stage-0 pins every one of them `tgenabled='O'`, and it is scoped to `trainer_id`
ALONE. Nothing truncates between tests. So two fixtures that write slots for the same trainer share
ONE overlap namespace, and they collide whenever the calendar walks a relative window
(`now() + N days`) onto a fixed one. That is not a hypothetical: it happened, and the failure
surfaced in a test that had nothing to do with either fixture.

### What was refused, and why it is not being patched

The previous batch watched the property from the CLIENT: `connection()` wrapped `query` and `end`,
bracketed every statement with an exact `slot_id → trainer_id` map plus a `pg_stat_xact_user_tables`
witness, and refused any row created or moved onto a trainer the current test did not own. Its
terminal review returned **NOT CLEAR: 7 P1 / 5 P2 / 2 P3**, and the core judgment was structural
rather than a list of bugs:

> Net-state blindness is inherent to before/after observation, but it is P1-blocking for the
> claimed property. Trigger unavailability does not turn incomplete evidence into proof. Either
> narrow the claim to surviving statement-end state or use a stronger isolation mechanism.

A statement-boundary observer can only ever speak about state that SURVIVES a statement. Patching
the bracketing would have moved the hole, not closed it. So the observer is REMOVED — `connection`
is now `new Client({…})` and nothing else — and the property is established where it can actually
be established: **a fixture cannot OBTAIN a trainer it does not own, so it cannot write one.**

### The three layers

1. **The brand.** `src/test/abc27TrainerAuthority.ts` exports
   `IsolatedTrainerId = string & { readonly [unique symbol]: true }`. The symbol is declared and
   never exported, so the property key cannot be named outside that module — an `as`-cast is the
   only forge the type system leaves open under this repository's `strict: false`, and §3 closes
   it. Intersection assignability is not strictness-gated, so the brand holds as written.
2. **The registry.** Every factory acquires before it writes, against a process-wide `Map` with
   **no database key**: a trainer belongs to one test in every database and every clone. A second
   identity asking for the same id throws AT ACQUISITION — before a row exists, so a refusal
   leaves no residue. Dropping the database key deletes the rename/DROP-carry class outright
   (P1 :875) rather than repairing it.
3. **The guard.** `scripts/check-abc27-trainer-source-authority.mjs` builds a `ts.Program` over the
   authority module and the suite, lexes every string and template literal as SQL (a real lexer:
   nesting block comments, dollar quotes, `E'…'`, `U&"…"`, doubled quotes), and requires every
   write to `availability_slots` to bind `trainer_id` to a branded interpolation, a branded `$k`
   argument, or `unnest($k)` over a branded array. Everything it cannot classify is REFUSED.

**Scope, stated rather than implied — and it cannot drift silently.** The guard reads three files:
the authority module, the ABC-27 realpg suite, and the authority's own unit suite. It says nothing
about `d7RuntimeContract.realpg.test.ts` (73 write sites) or `d7Performance.realpg.test.ts`, which
run in their own clusters with their own trainer handling; adopting the authority there is an
explicit follow-up, named here rather than left to be discovered. **A scope tripwire keeps that
boundary honest inside the ABC-27 family**: any other `src/test/abc27*` file that names
`availability_slots` beside a write verb is REFUSED until it is added to the guard's program
deliberately — so the bounded claim cannot quietly become a false one by someone adding a file.

**The claim, stated at the width the evidence carries.** A second review round narrowed it further
than the first draft did, and the narrowing is kept rather than argued with:

* A trainer id another test owns cannot be **acquired**: the registry throws, in every run, keyed on
  the canonical UUID rather than on the text that spelled it.
* A trainer id that is not authority-issued cannot **reach** `availability_slots` from any write
  site the guard can classify — and a site it cannot classify is refused, not skipped.
* A branded value that is not the *current test's* is refused where it is statically visible: the
  brand proves the authority issued an id, **not which test holds it**, so a trainer expression that
  reads a binding which **outlives one test** is refused. "Outlives one test" means module scope or
  a `describe`/`suite` callback body — that callback runs once at collection, so every test in the
  group reads the same value. A local of an `it` callback, or of any helper function, is per
  invocation. What this does not cover is a branded value threaded from one test to another through
  a function call; measured, no site does this, and it is stated rather than claimed away.
* **The indirect (apply/extend) path inherits the trainer of the SOURCE SLOTS THE FIXTURE SUPPLIES**,
  and that premise is now GATED rather than only measured. The cores write `v_r_trainer` aggregated
  from the locked source rows and digest-verified against the reviewed intent, so the property holds
  given that a fixture supplies its own slots. A `slots:` argument handed to an apply or preview
  driver may therefore not read a binding that outlives one test — the same question that decides a
  trainer, asked of the value the server derives the trainer FROM. Every such argument was also
  inventoried: each is a `seedApplySeries` return, a locally created id, or a deliberate
  non-existent `randomUUID()`. **The residual that remains** is a slot id a fixture obtains some
  other way inside its own test — by asking the server for one — which nothing static forbids.
* An **opaque interpolation is refused anywhere** in a write to this table. An earlier revision
  admitted one inside a non-trainer VALUE, arguing that the separating commas are static so an atom
  can only ADD an expression and PostgreSQL refuses a row with more expressions than columns. **That
  argument is wrong and is withdrawn:** a fragment can close its own row and open another of exactly
  the right arity — `x), (foreign_trainer, …` — and the second row's trainer is invisible to a
  reader looking at the first. What replaces it is a second brand. `sqlFragment()` VALIDATES that a
  text is one SQL expression — balanced parentheses, no top-level comma, no statement separator, no
  comment marker, no unterminated string or dollar-quote — and brands it, so a fragment cannot close
  a row, open a row, end a statement or comment away what follows. The three fixture helpers route
  their overrides through it. The reader therefore admits a fragment on a **runtime guarantee**
  rather than on an argument about arity. **And that guarantee is about an UNQUOTED position only.**
  `sqlFragment("x', 'y")` is one expression; wrapped in quotes it did not write, `'x', 'y'` is two.
  So a validated fragment is refused inside a SQL string literal, and a value that belongs there
  uses `sqlUuid()` — a canonical UUID, hex and hyphens, safe in either position.
* **No claim at all is made about mid-statement transient states** — with no obtainable foreign
  trainer id, that path has no source to draw from.
* And a **census** proves the committed residue of a real run carries no shared-namespace slot,
  which is the end-to-end half. It proves the shared constant is unused; it does not by itself prove
  pairwise ownership uniqueness, which is what the registry does.

### What changed in the suite

- The three SQL-side trainer mints are gone. `('9e0f…' ‖ lpad(g.i,12,'0'))::uuid` and its `9f9f…`
  twin are now `mintTrainerRange(…)` + `unnest($k::uuid[]) WITH ORDINALITY AS t(id, i)` — the ids
  are byte-identical and `t.i` reproduces `g.i`, so no digest-pinned fixture moved. The fifty
  `gen_random_uuid()` trainers of the hold-sweep fixture are now acquired from the authority before
  any row exists.
- Fixture helpers take the brand rather than a free-form override key: `seedApplySeries`'s
  `o.trainer`, and a dedicated branded parameter on `mkSlot`/`srcSlot` (a `Record<string, string>`
  admits any spelling, so a trainer threaded through one is exactly the untyped source this
  removes).
- **Two corrections to the earlier inventory.** The retired scan counted INSERTs only; there are
  **12** UPDATE sites against `availability_slots` in this suite, three of which assign
  `trainer_id`. The twelfth was found by the second review round: it lives inside a dollar-quoted
  PL/pgSQL body (`CREATE FUNCTION … AS $zz$ … UPDATE public.availability_slots … $zz$`) that the
  first version of this reader reduced to one opaque string token. Dollar-quoted bodies are now
  lexed recursively, with client parameters dropped on the way down — `$1` inside a body is that
  routine's argument, not something `pg` binds. The pinned inventory is **45** sites: 32 INSERTs,
  12 UPDATEs, 1 declared exemption.
- **The indirect path is evidential, not just structural.** The frozen migration has exactly two
  server-side creators (`abc27_p_normalized_apply_create` / `…_apply_extend`), both writing
  `v_r_trainer[cp.ord]` aggregated from the locked source rows and digest-verified against the
  reviewed intent. One statement in the create end-to-end exercise now asserts it: the DISTINCT
  trainer set of the target slots, addressed by target id, is exactly the fixture's series trainer.

### The CI change is a net saving, and it is gated twice

The `db-trainer-guard` job ran the entire database suite a second time (~224 s) to arm an observer
that was off by default. It is REPLACED by two steps in `lint` — an independently required
branch-protection context that nothing aggregates — **and by the same two steps in
`workflow-contract`, which IS a prerequisite of the aggregator `test`.** The duplication is
deliberate and mirrors the contract check that `lint` already carries in the opposite direction:
branch protection is configuration this repository cannot evidence, so the guard is also placed
where the workflow itself shows it gating the required check. Both copies together cost about four
seconds. They are measured at about **1 s** for the guard and
**2 s** for its 60-fixture self-test. `EXPECTED_PREREQUISITES` loses the job; the workflow
contract pins the two new scripts by exact text and forbids their lifecycle hooks.

**And one hole is closed for every lane at once, not just this one.** The contract now rejects a
vitest name filter (`-t` / `--testNamePattern`) in any CI `run:` block or any npm script it pins,
and rejects `testNamePattern`/`passWithNoTests` at the root or on either project. A filter matching
nothing selects all 142 files, runs zero tests and exits 0 — which is what a hollowed-out lane
looks like from the outside (P1 `workflow-contract.mjs:1128`).

### Every one of the 14 findings has a disposition

Nothing is silently absorbed. `RETIRED-WITH-MECHANISM` means the bytes the finding indicts are
deleted and their claim is not re-made anywhere.

| # | Finding | Disposition |
|---|---|---|
| P1 `:755` | net-state blindness: an UPDATE that moves a trainer and restores it inside one call is invisible | **RETIRED-WITH-MECHANISM.** No observer. The claim is narrowed exactly as the reviewer asked, and the transient path has no obtainable foreign id to draw from. |
| P1 `:742` | first/close sweeps accept a trainer declared by ANY test | **RETIRED-WITH-MECHANISM.** `sweepUndeclared` is deleted; ownership is per-test at acquisition, never per-suite at observation. |
| P1 `:927` | a fresh client's first readable baseline is adopted unswept | **RETIRED-WITH-MECHANISM.** There is no baseline. |
| P1 `:825` | `end()` is not a guaranteed final observation | **RETIRED-WITH-MECHANISM.** `end` is unwrapped; nothing is deferred to it. |
| P1 `:963` | appending the database error to the namespace error lets `.toThrow()` accept the wrong one | **RETIRED-WITH-MECHANISM.** No refusal is raised from inside `query`, so no error is combined. |
| P1 `:875` | rename copies rather than moves ownership; stale target owners survive | **DESIGNED OUT.** The registry has no database key at all, so there is nothing for a rename or a DROP/CREATE to carry. |
| P1 `wc.mjs:1128` | the contract does not reject `testNamePattern` / `passWithNoTests` | **CLOSED BY NEW CHECK** (§8 of `checkWorkflowContract`), with four mutation controls in `rehearsalSharding.test.ts`. |
| P2 `:809` | `di` is session-local while `created` is a whole-table diff | **RETIRED-WITH-MECHANISM.** The witness is deleted; nothing counts rows. |
| P2 `:30056` | the static inventory is fail-open (`factoryBound` is file-global, a nearby declaration is accepted, `INSERT/**/INTO` and COPY/MERGE are invisible) | **REPLACED.** Not patched: the regex scan is deleted and a compiler-API reader takes its place. Each named escape is a self-test fixture (`m4-comment-split`, `m4-nested-comment`, `m4-lowercase-spacing`, `m4-unicode-escape`, `m4-merge`, `m4-copy`, `m4-split-literal`). |
| P2 `:850` | the shallow copy does not close the Submittable path | **RETIRED-WITH-MECHANISM.** No statement text is classified at runtime, so there is no exemption to submit past. |
| P2 `:904` | the failed-probe fallback captures identity after execution and masks simultaneous errors | **RETIRED-WITH-MECHANISM.** The probe and its fallback are deleted. |
| P2 `:30130` | the evidence controls are non-discriminating (`blockEnd` is EOF; the swap assertion proves PostgreSQL swapped rows; the close test never rejects) | **REPLACED.** The controls die with their mechanism. What replaces them is a real cross-test sequence: one test acquires an id, the NEXT test's acquisition is refused and the refusal names the owner. Run under a filter that selects only the second test, the acquisition SUCCEEDS and the assertion goes red — a vacuous control fails in the right direction. |
| P3 `:627` | the counter documentation contradicts the implementation; autocommitted net-zero DML is still called "harmless" | **DIES-WITH-BYTES.** Both comments are deleted with the observer. |
| P3 `:30180` | the controls say a trigger is installed rather than describing the observer | **DIES-WITH-BYTES**, and the census control's commentary now names the authority. |

### The `idle_session_timeout` flake, fixed separately

A GUC-witness control sent `SET idle_session_timeout = '7s'` on its `control` client and never reset
it. In a full-suite run that client then sits idle for well over 7 s while the arms below install a
whole migration on other clients; the server kills the session and the next statement on it fails.
It had failed three times and passed three times on identical bytes.

**The fix is two lines of SQL in the same multi-statement send:** `RESET idle_session_timeout;` and
`RESET "wal_sender_timeout";`. No idle window with a live timeout ever exists. `pg_stat_statements`
records at EXECUTION, so both SETs are already in the recorder's answer before the RESETs run — the
arm proves exactly what it proved before, and the two RESETs are added to its pinned
`exemplarGucOperations` list. This is the same hygiene the arm already applied to `lock_timeout`
and `transaction_timeout`.

### Why not per-test databases

Per-test isolation would not even be *total* here: the suite's subject is a shared lineage
(`abc27_main` / `abc27_predecessor`, built once in `beforeAll`), roles are cluster-wide, and many
checkpoints deliberately observe cross-database facts — so tests would still share databases and the
collision class would survive. It is also *weaker* (it says nothing about two fixtures on the same
lineage database, which is where the 2026-08-29 collision happened) and infeasible within the
invariants: 222 tests × template-clone cost on a cluster that already measured `CREATE DATABASE`
contention. The source authority is stronger where it matters — reuse is refused at acquisition,
across every database and clone, at O(1) cost — and it leaves the lineage evidence untouched.

### What the first review round of THIS batch found, and what changed

Eleven P1, three P2 and one P3, on the source-authority bytes. All of it is fixed or narrowed in
place; nothing is carried.

| Finding | What changed |
|---|---|
| P1 · a branded value proves ORIGIN, not ownership — one retained across tests would be a shared namespace | Each branded interpolation now carries an index back to the expression that produced it, and a trainer expression that reads a **module-scope binding** (a variable, or a property whose access chain roots in one) is REFUSED. A value laundered through a function call is not covered and is named as a residual. |
| P1 · the apply/extend path derives the target trainer from caller-supplied SOURCE SLOTS, so a fixture could pass another test's slot | Not code, claim: the runbook now states the premise explicitly. Every `slots:` argument in the suite was inventoried — each is a `seedApplySeries` return, a locally created id, or a deliberate non-existent `randomUUID()`; **none is a server-side pick**. Stated as a measurement, not a guarantee. |
| P1 · the registry keyed on the raw string while PostgreSQL keys on the UUID | `canonicalTrainerId` folds case, hyphens and braces to one key, refuses anything that is not a UUID, and the CANONICAL form is what is issued — so the value that reaches SQL is the value the registry keyed on. Four unit tests, including the cross-spelling refusal. |
| P1 · brand containment was syntactic, so an aliased type import defeated it | R1 is now resolved by the CHECKER, in BOTH directions: an assertion producing the brand is refused, and so is one that WIDENS a branded value away (`arr as string[]` then mutate). And a declaration typed as the brand whose initializer is not branded is refused — under `strict: false` an `any` widens in with no cast at all. |
| P1 · a dollar-quoted PL/pgSQL body was one opaque token, and the suite really executes an `UPDATE public.availability_slots` inside one | **Confirmed, and it was a real miss.** Dollar-quoted bodies are now lexed and classified recursively, with client parameters dropped on the way down. The inventory moved 44 → 45. |
| P1 · an opaque interpolation could carry `, trainer_id = …` into an UPDATE's SET clause | No atom is admitted anywhere in the SET clause of an UPDATE to this table — a SET list has no expression count for PostgreSQL to refuse. The INSERT case keeps its arity argument, and the residual (a fragment that closes the VALUES row, or carries `;`/`--`) is now named in the claim. |
| P1 · the `$k` array was "the second argument of whatever call this literal sits in" | A `$k` or `unnest($k)` binding is resolved only inside `<expr>.query(sql, params)` — the shape `pg` actually binds through. A wrapper presenting a decoy array is refused. |
| P1 · `unnest` provenance matched on alias alone, so a decoy could bless a same-named alias | Two bindings with one alias is a REFUSAL, not a guess. |
| P1 · one exemption could conceal several writes in a data-modifying CTE | An exempt statement's writes are counted; more than one is refused. |
| P1 · the contract loaded the vitest config without `VITEST=true`, which vitest sets before loading | The config is loaded TWICE — plain and under `VITEST=true`/`MODE=test` — and both are checked. Additionally `vitest.config.ts` is required to read no environment at all, so the two loads cannot legitimately differ. |
| P2 · the scope tripwire scanned only direct `src/test` entries, case-sensitively | Recursive, case-insensitive, and its write-verb pattern now sees a comment between the verb and the table. |
| P2 · the claim was broader than the evidence | Rewritten, bullet by bullet, above. Every residual it does not cover is named. |
| P2 · merge gating rested on branch-protection settings the repository cannot evidence | The two guard steps are ALSO run in `workflow-contract`, which is a prerequisite of the required aggregator `test` — so the gating is visible in the workflow rather than taken on trust. |
| P3 · the recorded self-test count was 47 where the command runs 49 | Corrected, and it is 61 now. |

### What the second review round found, and what changed

Six P1 and three P2, on the bytes that answered round 1. All fixed. The headline one is fixed by
CLASSIFICATION rather than by narrowing, because the narrowing round 1 produced rested on an
argument that turned out to be false.

| Finding | What changed |
|---|---|
| P1 · an opaque interpolation in a non-trainer VALUE is still a bypass — a fragment can close its row and open another of equal arity | **The arity argument is withdrawn.** An unresolvable interpolation is refused ANYWHERE in a write to this table. A second brand takes its place: `sqlFragment()` validates that a text is one SQL expression and brands it, and the three fixture helpers route their overrides through it. The reader now admits a fragment on a runtime guarantee instead of on an argument. |
| P1 · `ON CONFLICT DO UPDATE SET trainer_id` unchecked; `INSERT … SELECT` stops after the first arm | Both read. The upsert arm uses the same SET rules as an UPDATE; every arm of a set operation is checked, bounded by the enclosing parenthesis so a data-modifying CTE's outer SELECT is not mistaken for another arm of the inner one. |
| P1 · R1 covered only the initializer, so a later assignment or `push` kept the branded type | Assignment into a branded binding, and in-place mutation of a branded array, are both refused. |
| P1 · module scope is the wrong lifetime proxy — a `describe` callback body persists across tests | The rule now asks whether a binding OUTLIVES one test: module scope, or a `describe`/`suite` callback body. A local of an `it` callback or of any helper is per invocation. |
| P1 · identity was the test NAME, and Vitest permits duplicates | Every test start takes an ordinal; the identity is `<ordinal>:<name>`. Two deliberately identically-titled tests prove it. |
| P1 · the `VITEST=true` config load was checked only for the two name-filter options | The two loads are compared BY VALUE across everything the contract depends on, so any divergence is a refusal. The token rule widens to `process`, `import.meta`, `loadEnv`, `require(`, and the config's imports are pinned to three specifiers. |
| P2 · `EXECUTE '…'` and `CREATE FUNCTION … AS '…'` bodies were skipped | A plain string is read as SQL where SQL puts one in an executable position; ordinary string data is still data. |
| P2 · the scope tripwire missed `INSERT--x\nINTO` and `MERGE/**/INTO` | It matches the four verbs alone. Its only demand is that the file join the program, so a wider match costs nothing. |
| P2 · nothing gated the apply-path premise | A `slots:` argument handed to an apply or preview driver may not read a binding that outlives one test. The residual — a slot id obtained some other way inside the fixture's own test — is still stated above rather than claimed away. |

### What the third review round found, and what changed

Six P1 and two P2, on the bytes that answered round 2. All fixed. Two were defects in round 2's own
fixes, which is the useful kind of finding.

| Finding | What changed |
|---|---|
| P1 · `sqlFragment("x', 'y")` is one expression, and inside static quotes it becomes `'x', 'y'`, which is two | **The invariant is split in two.** "One SQL expression" is right for an UNQUOTED position and wrong inside quotes, so a validated fragment is now REFUSED inside a string literal and a third brand — `SqlQuotedLiteral`, minted by `sqlUuid()` — carries a value that belongs there. Its invariant needs no lexing at all: a canonical UUID is hex and hyphens. |
| P1 · an INSERT that omits `trainer_id` returned before its `ON CONFLICT DO UPDATE` was read | The upsert arm is read first and unconditionally. |
| P1 · `UNION … VALUES (…)` and `UNION … TABLE` arms were skipped | Refused rather than parsed: the top-level set-operator count must equal arms − 1, because an arm with no projection this reader can locate still contributes rows. |
| P1 · the apply gate only saw an options object written inside the call | The options argument is followed — through parentheses, a `const` bound to an object literal, and spreads. |
| P1 · an IIFE inside a `describe` body escaped the lifetime rule | The walk continues past an IIFE to the function enclosing it. The first fix was itself wrong and its fixture caught it: `(async () => {…})()` puts a `ParenthesizedExpression` between the arrow and the call, so no IIFE was ever detected. |
| P1 · `testTrainer` read `currentTestName` without the `insideTest` gate | It uses the same gate the identity does. A hook now gets the documented refusal instead of deriving the previous test's id, proved by a control that runs it from a `beforeAll` and asserts the stale name really was available. |
| P2 · a helper trusted branded fragment PARAMETERS, which an `any` argument satisfies | The parameters are plain strings again and the validator is called in the body. |
| P2 · a self-test fixture used `await` in a non-async callback, so it was not runnable Vitest code | Fixed. A fixture that could never run is a verdict about a shape the suite cannot contain. |

### What the fourth review round found, and what changed

Five P1 and one P2. All fixed.

| Finding | What changed |
|---|---|
| P1 · a validated fragment was trusted OUTSIDE a value-expression position — `${sqlFragment('trainer_id')}` in a column list makes `trainer_id` absent from the list and the whole INSERT unexamined | A brand says what a VALUE is, not that it may stand where SQL expects STRUCTURE. An interpolation of ANY kind is now refused in the table reference, the column list, a SET assignment target and an `unnest` alias; and the quoted-fragment rule reads quoted identifiers as well as strings. |
| P1 · brand containment checked only directly brand-typed variables, so a branded RETURN type or object property minted a trusted brand with no cast | Three per-site rules are replaced by ONE: an expression whose checker CONTEXTUAL type is a brand must itself be branded. That is the same question the compiler asks when deciding the assignability that lets `any` through, so it closes annotated initializers, assignments, returns, arguments and array/object members together. The subsumed rules are deleted. |
| P1 · nested `SELECT`s were counted as set-operation arms, so the arms-versus-operators equality agreed while a real `UNION VALUES` arm went unread | Arms are recognised only at paren depth zero; anything else is refused rather than half-read. |
| P1 · the apply-options follower read only identifier-named property keys | String-literal, numeric and resolvable computed keys are read, and a key this cannot read is REFUSED rather than assumed to be a different key. |
| P1 · `describe('g', (async () => {…}))` escaped the lifetime rule | Parentheses are stripped on the collection callback — the same AST wrapper already handled for IIFEs. |
| P2 · the contract CLI control kept a 15 s budget although the double config load made it slower | The double load is kept (it is what proves CI runs the config this checks) and the control is given an explicit 180 s budget. |

## The weekly-default window is academy-local — a DST correction

**Test-fixture arithmetic only.** No product time window, calendar rule or timezone behaviour is
changed, and no other fixture's timebase moves.

Series identity is (trainer, location, **LOCAL weekday, LOCAL time**, duration), so "a whole week
later" has to be a CALENDAR step in the academy's zone. The 7.4-B fixture stepped it as
`'2026-09-01T17:00:00Z'::timestamptz + make_interval(days => 7N)`, and `timestamptz + interval`
steps days in the **session** zone — UTC here — which pins the UTC clock and lets the local clock
move. `17:00Z` is `19:00` in Europe/Amsterdam before the last Sunday of October 2026 and `18:00`
after it. The lane allocator reaches past that date, so the fixture's own claim that stepping a
whole week keeps two default slots template-IDENTICAL was false for any pair straddling the
transition.

The correction does the addition on a bare `timestamp` and converts once at the end:

```
(timestamp '2026-09-01 19:00:00' + make_interval(days => N)) AT TIME ZONE 'Europe/Amsterdam'
```

**Parity is preserved at the base:** 1 September is CEST (UTC+2), so that expression at `N = 0`
IS `2026-09-01T17:00:00Z` — every fixture pinning the pre-transition instant still means the same
instant.

Two controls measure it rather than asserting it. The first takes two occurrences nine weeks apart
on opposite sides of the transition and compares their local weekday and clock (`Tue 19:00` both
sides), their UTC offsets, the base parity, and the hour-long duration on both sides — and
evaluates the REPLACED expression beside it, so the control discriminates instead of merely
passing. The second sweeps the template vector including `extra_costs` — the field most easily
lost, being jsonb, last in the column list, and defaulted to an empty array.

> **Superseded below.** As first written, both controls were weaker than they read, and the fifth
> review round said so. The replaced expression does not simply "drift to `Tue 18:00`": it drifts
> only when the SESSION zone differs from the academy's, so on a host whose `initdb` picked
> Europe/Amsterdam it does not drift at all and the control failed. The offsets were read with
> `to_char(timestamptz, 'OF')`, which is itself session-relative. And the second control measured
> three fields, not the vector. See *The fifth review round stopped the static approach* for what
> each of them measures now.


## The fifth review round stopped the static approach, and what replaced it

**Test-fixture architecture only.** No product schema, timestamp, window, role, permission,
runtime or deployment behaviour is changed by anything in this section, and the frozen ABC-27
migration is byte-identical throughout (`05e04451f944cabf…`, 20,633 lines).

### The round-5 stop

The fifth and final review round of the trainer-source batch came back **NOT CLEAR: 3 P1, 1 P2,
1 P3** — all valid, none fixed. Four of the five were about one thing: the guard tried to decide,
statically, that each of the suite's 44 slot write sites bound `trainer_id` to a value the
authority had issued. That is a general dataflow question, and the round answered it four ways:

| Finding | The escape |
|---|---|
| P1 · `checker:625` | The `continue` skipped an atom-bearing `unnest` alias, and the interpolation atom is ONE word token — so `countSetOperators` never saw a smuggled `union`, and `AS ${sqlFragment("x(id) union all values ('foreign'::uuid, …)")}` was constructible. |
| P1 · `checker:1469` | `branded()` answered only "the brand, or an array of the brand". A CONTAINING type (`{ t: IsolatedTrainerId }` annotated from an `any`) and an annotation-widened alias (`string[] = brandedArr`, then mutate) both walked past it. |
| P1 · `checker:1394` | `slotsPropertiesOf` had no `GetAccessorDeclaration` arm, so `{ get slots() { return SHARED } }` reached the apply drivers unread. |
| P2 · `realpg:20607` | `to_char(timestamptz, 'OF')` renders the offset in the SESSION zone. `initdb` takes the HOST zone, so the control's claim that the replaced arithmetic drifts held only where the session zone was not the academy's — on this machine the asserted `Tue 18:00` read `Tue 19:00`, and the full db suite was RED on those bytes. |
| P3 · `realpg:20641` | The sweep control's title claimed every template field; it measured `extra_costs`, the local start and the duration. |

### The supersession

The three P1s are not patched. Each fix to the previous two guards moved the hole rather than
closing it — the observer before it was refused structurally for the same reason — so the
architecture moved instead.

**`src/test/abc27SlotFixtures.ts` is now the only place a slot write is spelled.** Nineteen
complete fixed statements (four INSERTs, fourteen UPDATEs, and the UPDATE inside the planted
drift trigger's PL/pgSQL body), no interpolation anywhere, every value a `$k` parameter. The
suite's 44 direct write sites are converted onto its entrypoints; the one deliberate
`SHARED_NAMESPACE_CONTROL` census exemption is unchanged.

**The load-bearing check is a runtime capability, not a type.** Every entrypoint that names a
TRAINER calls `requireOwnedByCurrentIdentity()` before it writes; every entrypoint that names a
SLOT — including a caller-supplied INSERT id — calls `assertSlotsNotForeign()` on it; and the six
writing apply paths call it on the EVALUATED `options.slots`. Both ask the registry about the string
that actually arrives — which is why all three brand escapes above are closed by construction
rather than by a rule: a containing type, a mutated alias and a getter all deliver an ordinary
string by the time the check runs. `sqlFragment`, `sqlUuid` and their two brands are RETIRED; the
`IsolatedTrainerId` brand survives with a smaller job (documenting provenance, keeping a raw
string out of a fixture parameter) and is no longer asked to carry a proof.

**The static guard is rewritten to a decidable question.** G1: any statement that writes
`availability_slots` outside the factory is refused, with no classification to defeat. G2: the
factory's statements must be plain literals, and where one binds `trainer_id` that binding must
be a `$k` parameter or an `unnest($k…)` alias column. R1 keeps brand containment, now with a
bounded containing-type walk that closes the P1 above — and asks whether a position REQUIRES a
brand rather than merely mentions one, because `pg`'s `query<R, I extends any[]>` infers `I` from
its own arguments, so a "some constituent is branded" test refused the whole repository. R2 refuses
a write whose target relation is a hole. The T/F/Q hole classification, the static lifetime rules
and the apply-options follower are deleted.

### The narrow, honest claim

> No INSERT, UPDATE, MERGE or COPY against `availability_slots` is spelled outside the factory in
> any text the guard can read, and the factory's statements admit no interpolation — both proved
> at CI, and what each entrypoint actually SENDS is proved byte-identical to one of those
> constants by a runtime control. Ownership itself is enforced at RUNTIME, in every invocation, on
> the values that arrive: a trainer this test does not own is refused before any statement is
> sent; a slot another test owns is refused before any UPDATE names it; and a source slot another
> test owns is refused before any of the six writing apply paths can derive a target trainer
> from it.

What is **not** claimed, stated rather than papered over:

- **No dataflow proof.** The guard reads SQL it can lex and compose from literals (`+`, `.join()`,
  `.concat()`); SQL a program computes by other means is not read. That is why the runtime check
  is the load-bearing one — a statement the factory did not send asked the registry nothing.
- **DELETE is outside the four guarded verbs**, deliberately: removing a row cannot create an
  overlap namespace. The suite deletes slots in several places and none of them is a bypass of
  anything claimed here.
- **An array widened by *annotation*** (not by a cast) and mutated through the alias is caught at
  runtime, by `requireAllOwnedByCurrentIdentity` reading every element, rather than by the guard.
- **Nothing about mid-statement transient states.**
- **Scope is the four named files.** `d7RuntimeContract.realpg.test.ts` (73 write sites) and
  `d7Performance.realpg.test.ts` are an explicit follow-up, and `checkScopeDrift` — now exercised
  by its own controls against a throwaway tree — will not let the scope widen silently.

### The DST controls, rebuilt

The P2 is fixed by measuring under BOTH session zones instead of assuming one. The corrected
expression gives `Tue 19:00` on both sides of the October transition under `UTC` and under
`Europe/Amsterdam`; the replaced arithmetic drifts to `Tue 18:00` under `UTC` and does **not**
drift under `Europe/Amsterdam` — so what the control now measures is the session-dependence
itself, which is the actual defect. The transition premise no longer uses `to_char(…, 'OF')`: it
subtracts the same instant read in two NAMED zones, which no session setting can move. The
fixture ARITHMETIC correction is kept exactly as it was; only its evidence is rewritten.

The P3 is fixed by widening the sweep to match its title: the whole stored row via `to_jsonb`
minus the five genuinely per-slot columns, asserted as an exact 29-key set AND compared between
two lanes — so a column added to the relation fails here rather than joining the template vector
unnoticed.

### The evidence, measured

| Gate | Result |
|---|---|
| `check:trainer-authority` | 19 fixed statements in the factory, 0 elsewhere, 1 declared exemption — **2.7 s** (budget was 30 s) |
| `check:trainer-authority:selftest` | 89 assertions over 58 fixtures, incl. the real repository — under 3 s |
| `npm run test:db` (ABC-27 file) | **230/230**, twice back to back |
| `npm run test:unit` | 392 files / 3,932 tests |
| `eslint .` | clean |
| `npm run typecheck:baseline` | 82 pre-existing errors, baseline 82 — no new ones |
| `npm run build` | ✓ |
| `scripts/ci/workflow-contract.mjs` | CI gate contract holds |
| `check:edge-pins` / `check:edge-config` / `check:legacy-key` | OK |

**The mutation battery (as first built: 18 mutants, 18 discriminating; it grew to 42 across the
five review rounds below, and every count in this table was re-measured at the end)**, each naming ONE non-overlapping sensor —
a mutant whose only evidence is "some gate failed" says a gate is noisy, not that a sensor works.
The battery restores every touched file from bytes captured before it starts and re-checks their
sha256 after each mutant, so it cannot leave the tree mutated.

| # | Mutation | Sensor |
|---|---|---|
| M1 / M2 | a raw slot INSERT in the suite, plain and with the comment-split verb | guard (G1) |
| M3 | a hole interpolated into a factory statement | guard (G2) |
| M4 | a SQL-side trainer inside the factory | guard (G2) |
| M5 / M5b | the write-time capability check removed, for one trainer and for a lane | runtime controls |
| M6 / M7 | the slot registry stops refusing a foreign claim / a foreign source | unit self-test |
| M8 | an id the registry never issued is accepted | runtime controls |
| M9 | the contextual brand rule reverts to "mentions a brand" | guard (refuses the repo) |
| M10 | the containing-type walk removed — the round-5 P1 verbatim | guard self-test |
| M11 / M12 | the exemption budget widened / the factory inventory loses a statement | guard self-test, guard |
| M13 | a vitest name filter in the db script | workflow contract |
| M14 | the scope tripwire disarmed | unit self-test |
| M15 | the weekly default reverts to session-zone arithmetic | **db suite** |
| M16 | a template column dropped from the sweep's expected key set | **db suite** |
| M17 | the apply drivers stop checking their source slots | **db suite** |

**M14 SURVIVED on its first run, and that is recorded rather than quietly fixed.** The scope
tripwire is dormant by design — no `src/test/abc27*` file outside the guard's program names the
relation beside a write verb — so disarming it changed nothing any sensor could see. A tripwire
nothing exercises is a tripwire nobody knows is connected, so it is now driven directly against a
throwaway tree (three cases: a sibling that writes is refused, the same file inside the program is
not, a sibling that only reads is left alone). M14 discriminates on the re-run.

**M15 is the round-5 P2's own fix, proved.** Reverting the weekly default to `timestamptz +
interval` now turns the db suite RED **on this host** — the machine where the previous control
could not tell the difference, because its session zone happens to be the academy's.

### One defect the conversion itself introduced, and how it was found

Moving the writes into the factory separated ACQUIRING a trainer from WRITING with it. The
authority's `ensureProfiles` note already predicted the consequence in those words — a fixture
that acquires inside a transaction it rolls back keeps the id (the registry is in memory and has
nothing to roll back) while `trainer_profiles` loses the row — and the first full db run duly
failed `availability_slots_trainer_id_fkey`. The factory now ensures the referential row itself,
immediately before it writes and only AFTER the capability check, so a refused trainer still costs
no row at all.

### What the first review round of this batch found, and what changed

Five P1, one P2, three P3 — all valid, all fixed. Two of the P1s were holes the previous
architecture did not have; three were holes it had and this one inherited by reusing its reader.

| Finding | What changed |
|---|---|
| P1 · a CTE-prefixed `WITH x AS (…) UPDATE public.availability_slots …` was invisible, because `UPDATE` was only read as a verb where a statement could BEGIN and its preceding token is `)` | The TABLE NAME answers now, unconditionally. The positional test survives only for the unresolved-target arm, where it is what stops `GRANT INSERT, UPDATE …`, `FOR UPDATE`, a policy's command list and the word in prose from reading as writes. |
| P1 · every factory UPDATE that did not MOVE the trainer skipped the capability check — `shiftSlotTimes(c, someoneElsesSlot, { minutes: 60 })` walks another test's slot along its own trainer's calendar, which is the collision itself, through a helper that names no trainer | Every UPDATE entrypoint now runs its slot id through `assertSlotsNotForeign`, and so does the drift-trigger plant. A control writes a slot in one test and has the next test try five different setters on it; none reaches the server. |
| P1 · two writing apply paths never checked their source slots — the `as_actor` wrapper used for receipt privacy and the operator-reachability flow — and two more replay-SHAPE controls were found beside them | All five now call one `enteringApplyWrite` helper, which checks the sources and claims the targets. A tripwire pins both the number of writing call texts and the number of guarded sites, with the needles composed from halves so the pin does not count its own literals. |
| P1 · `INSERT INTO t AS s (cols)` is valid PostgreSQL, and the alias hid the column list — no trainer binding was found, so a statement storing a fixed foreign trainer passed the factory audit | The optional alias is read, and an INSERT whose column list this cannot read is now REFUSED rather than passed — including the column-less `INSERT INTO t VALUES (…)` form, where the trainer lands by position. |
| P1 · the guard read the source LITERAL, not the text sent; byte-equality was pinned for `insertSlot` alone, so `SLOT_UPDATE_PRICE.replace(…)` inside an entrypoint would send a statement it had audited in another form | A control drives EVERY entrypoint and requires each sent text to be byte-identical to an exported constant, in both directions. Running it the first time found `PLANT_DRIFT_TRIGGER` sent but missing from the exported record. |
| P1 · a statement assembled by `['INSERT INTO public.avail', 'ability_slots…'].join('')` was read as two harmless fragments | `.join()` on a literal array and `.concat()` are constant-folded exactly as `+` already was. This is folding, not a deny-list: anything that cannot be folded stays unresolved, and that residual is now stated in the honest claim instead of being implied away. |
| P2 · the inventory keyed writes as `file:line:verb` in a Set, so two UPDATEs inside one literal — the planted trigger's body is such a literal — collapsed to one | Keyed by the verb's token offset as well, so R4 performs the addition tripwire it claims. |
| P3 · "every entrypoint", "any statement", "no write outside" read wider than the implementation; DELETE is outside the four guarded verbs and the suite uses it | The claims are narrowed in the code and above: the four verbs are named, DELETE is named as excluded WITH the reason (removing a row cannot create an overlap namespace), and the folding limit is stated. |
| P3 · the unit-test count and the earlier DST narrative disagreed with the corrected account | Corrected, and the earlier DST paragraph now carries an explicit **Superseded below** note rather than being silently rewritten. |

**Two of the new mutants survived on their first run and both were the MUTANT's fault, recorded
because a survivor is evidence either way**: one changed only the table alias while leaving the
trainer parameter-bound, so the statement stayed correct and passing was right; the other removed
the slot check while no control exercised a cross-test slot edit. The first was strengthened to do
both halves; the second produced the missing control. The battery is now **24 mutants, 24
discriminating**.

**One load sensitivity, stated rather than hidden**: `rehearsalSharding`'s "the CLI its CI job
runs exits 0 and says so" spawns the whole contract checker as a child process and double-loads
`vitest.config.ts` on purpose. It passed alone and in an idle full-suite run, and expired once
inside a long back-to-back gate sequence. That is the property its own 180 s budget was added for
in the previous batch; nothing in this batch touches the contract CLI's cost.

### What the second review round found, and what changed

Five P1, two P2, two P3 — all valid, all fixed. Every one of them was a place where a fix from
round 1 had narrowed a hole without closing it, or where a tripwire pinned one spelling of the
thing it was supposed to pin.

| Finding | What changed |
|---|---|
| P1 · the R2 unresolved-target arm still demanded a statement-start position, so `WITH x AS (…) UPDATE public.${t} …` escaped BOTH arms; and MERGE/COPY only asked whether the relation appeared anywhere, so an unresolved MERGE target was never examined | The positional test is gone entirely — nothing that is not followed by a HOLE reaches the arm, which is what kept `GRANT INSERT, UPDATE …`, `FOR UPDATE` and policy command lists out. MERGE and COPY now read their targets properly, which also fixes the other direction: `MERGE INTO other USING availability_slots` and `COPY … TO STDOUT` are reads and are no longer called writes. |
| P1 · G2 passed two valid PostgreSQL forms it did not understand — `SET (trainer_id, location_id) = (…)` and an INSERT whose value source is `TABLE src` | Both fail closed. A SET target that mentions the trainer but is not one plain column name is REFUSED rather than skipped; an INSERT that names `trainer_id` in its column list and whose source this cannot decompose (only `VALUES` and `SELECT` are read) is REFUSED. |
| P1 · `checkScopeDrift` read RAW source, so a sibling file outside the program carrying `['INSERT INTO public.avail', 'ability_slots…'].join('')` contained no contiguous table name — invisible to the tripwire, and never folded either because it never entered the program | The tripwire searches the SQUASHED text as well: the seams between adjacent string literals (a closing quote, `+`/`,`/`.concat(`/`.join(…)`, whitespace, the reopening quote) are deleted before the match. A third scope-drift control drives exactly that file shape. |
| P1 · the byte-equality control named its own list of entrypoints, so `export const unsafeUpdate = (c, id) => c.query(SLOT_UPDATE_CAPACITY, [id, 9])` would add no literal, no site and no constant, and simply never be called | The module's exported surface is enumerated at runtime and pinned, and the exercised list is compared against it — so "every entrypoint" is a claim about the module rather than about the test's memory. |
| P1 · the writing-apply tripwire counted the exact rendering `SELECT * FROM public.<routine>(`, and the revoked-manager barrier is spelled `SELECT status, round_id FROM …` | The needle is `FROM public.<routine>(`, which catches every projection while still excluding the two `GRANT EXECUTE ON FUNCTION` lines. That call site was in fact unguarded; it is guarded now, and there are six writing paths, not five. |
| P2 · `w.at` is an index within each split statement, so two `UPDATE`s separated by a `;` inside ONE literal still collapsed to one inventory key — the round-1 P2 had moved, not closed | Keyed by the verb token's own `pos`, the byte offset the lexer recorded, which is unique across the whole literal. |
| P2 · every string literal is read as SQL, so an ordinary message like `'UPDATE public.availability_slots failed'` would be refused | Not changed — it is the direction to fail in, and that is now stated in the guard's header rather than left for a reader to discover. A refusal is loud, names the site and is fixed by rewording a string; the opposite mistake is a write nobody sees. |
| P3 · comments still said "every slot write" without the DELETE qualification, the inventory key was documented as `file:line:verb`, and the census title still said "no fourth one" | All corrected. |
| P3 · `srcSlot` in the wrapper describe still carried a comment about a fragment validator that no longer exists, and its defaults still carried SQL quote characters — `'2026-09-01T17:00:00Z'` INCLUDING the apostrophes, handed to a `::timestamptz` cast | Comment rewritten, quotes removed at the defaults and at the one caller that passed them. The db suite is unchanged at 230/230, so no pinned digest depended on the old value. |

The battery is now **31 mutants, 31 discriminating**, with M24–M31 covering each fix above.

### What the third review round found, and what changed

Four P1, all valid, all fixed. Every one was the same shape of mistake: a check that recognised
the patched form rather than the general one.

| Finding | What changed |
|---|---|
| P1 · a COMPOUND INSERT source was half-read — `… SELECT $1, $2 UNION ALL TABLE src` records a binding for the readable arm, so the round-2 "did I find any binding" fallback answered yes while the other arm went unclassified | A set operation or a `TABLE` arm at paren depth zero after the column list is now a refusal in itself. This reader decomposes ONE arm, so more than one is refused rather than half-read. (The scan also had to start AFTER the column list's closing paren; starting on it drove the depth counter to −1 and skipped everything — found by the fixture, not by inspection.) |
| P1 · `INTO` is OPTIONAL after `MERGE`, and the guard read it as required, so `MERGE public.availability_slots AS t USING … WHEN MATCHED THEN UPDATE SET …` was skipped entirely | The target is read whether or not `INTO` is present. |
| P1 · `checkScopeDrift` squashed string-literal seams before looking for the TABLE NAME but tested the write verb against RAW text only, so `['IN', 'SERT INTO public.availability_slots …'].join('')` was still invisible | Both questions are asked of both texts. A fourth scope control drives exactly that file. |
| P1 · invoking an export is not the same as its check having run: deleting `await ownedSlot(id)` from one setter leaves the export list, the statement bytes and both controls unchanged | A REFUSAL MATRIX drives every writing entrypoint once with a subject this test does not own — a foreign slot for the setters and the drift plant, a foreign trainer for the inserts — and requires a refusal with nothing sent. The matrix's key set is compared against the pinned export surface, so a new entrypoint must appear in both. |

Mutants M32–M35 cover these.

**The round-3 table above says "fixed" of its four findings, and a fourth round then showed two of
them fixed only for the shape round 3 had used** — the compound-source scan was depth-gated, and
the refusal matrix supplied two foreign capabilities where one check could carry the rejection.
Both are closed below. The tables in this section are a record of what each round found, not a
running certificate; the current state is the last one.

### Three load-sensitive controls this batch does not own

`the psql resolver spends one budget across all candidates, and fails loudly when none answers`
(realpg ~13254) failed with `invoked: false` — the temporary `#!/bin/sh` fake it spawns never
reached its `echo` inside the control's 1,500 ms budget.

**Measured, not guessed: 2 failures in 14 db runs of this batch, and the two were consecutive.**
Three runs immediately afterwards were 230/230 each. What causes it is NOT established here — the
consecutiveness is suggestive and nothing more, and a round-5 review was right that calling it a
transient machine state was a claim the measurement does not support. What IS established is that
no hunk of this batch's diff touches the control or anything it calls, and that the control is an
unreliable gate on these bytes.

It exercises `resolvePsql` and nothing else; **no hunk of this batch's diff touches it or anything
it calls**, which was checked against the diff rather than assumed.

**Two more behaved the same way, and all three share a shape**: each spawns a heavy CHILD PROCESS
and holds it to a wall-clock budget.

| Control | Observed | Alone |
|---|---|---|
| `the psql resolver spends one budget across all candidates` (realpg ~13254) | 2 failures in 14 db runs, consecutive | 3 clean runs immediately after |
| `the CLI its CI job runs exits 0 and says so` (rehearsalSharding) — spawns the whole contract checker, double-loading `vitest.config.ts` on purpose | 1 failure, inside a long back-to-back gate sequence | passes standalone; passes in an idle full-suite run |
| `runs the REAL project through the REAL child` (tscBaselineChecker) — spawns a real `tsc` | 1 failure, in a sequence where `typecheck:baseline` had just run its own `tsc` | passes standalone twice; full unit suite 392/392 alone |

None of them is touched by this batch's diff, and all three pass when the machine is not already
running another child of the same kind. They are recorded rather than repaired, because repairing
unrelated controls inside this batch is exactly the kind of silent widening it is trying not to do
— and because the honest statement is that this repository has three gates whose verdict depends
on machine load, which is worth someone's attention on its own.

### What the fourth review round found, and what changed

Eight P1, three P2, five P3 — all valid. Three of the P1s were round-3 fixes that recognised only
the shape round 3 had used, which is the failure mode this whole batch keeps meeting.

| Finding | What changed |
|---|---|
| P1 · the compound-source scan ran at paren depth zero, so `INSERT … ( SELECT … UNION ALL TABLE src )` put both arms at depth one | The scan runs at every depth. G2 governs the factory alone, whose statements contain no set operation and no subquery, so looking everywhere costs nothing. |
| P1 · `ON CONFLICT … DO UPDATE SET trainer_id = '<literal>'` was never audited — the INSERT's own `VALUES` bound a parameter and was accepted, and `writesToTable` does not see the conflict clause as a separate UPDATE because its verb is followed by `SET` | The conflict clause's assignments are read from the INSERT that contains them, by the same rules. An acceptance fixture keeps the rule about the BINDING rather than about the clause existing. |
| P1 · the SET-list terminator was the first `FROM`/`WHERE`/`RETURNING` at ANY depth, so a subquery in an earlier assignment truncated the scan before it reached `trainer_id` | The terminator is sought at paren depth zero. |
| P1 · `checkScopeDrift` still matched TEXT, so putting the verb and the relation in separate `const` declarations defeated the squash | The question changed from "does this text look like a slot write" to **"does this file send SQL at all"** — a `.query(…)` call, read from the syntax tree. It needs no type information (the file is not in the program, which is the point), is immune to how the text was assembled, and distinguishes a call from a comment, which a substring match cannot. The text match survives beside it for a file that exports slot SQL without sending it. No `src/test/abc27*` file outside the program calls `.query(` today, so the rule costs nothing. |
| P1 · the export pin filtered to function-valued exports, so `export const unsafe = { update: … }` was dropped | The WHOLE export surface is pinned, of every kind. |
| P1 · the refusal matrix gave the trainer-moving setters BOTH a foreign slot and a foreign trainer, so either check could carry the rejection and deleting the slot check left it green | One capability per case: those three get a foreign slot with an OWNED trainer, and a second pass gives them an owned slot with a foreign trainer. |
| P1 · a caller-supplied INSERT id was registered by `claim(rows)` AFTER the write — so test A's rolled-back explicit id could be re-inserted by test B and only then refused | `s.id` goes through `assertSlotsNotForeign` before the statement is sent, with its own matrix case. |
| P1 · the writing-apply census counted call TEXTS, and the wrapper's SQL is stored once in a `CALL` map — a second `client.query(CALL.…, …)` would move no count | Uses of the stored call text are counted and pinned too. |
| P2 · two identical literals on one physical line produced one inventory key | The key carries the literal's own start position as well. |
| P2 · `… FOR UPDATE ${lockMode}` read the interpolation as an UPDATE's table reference | `FOR UPDATE` and `FOR NO KEY UPDATE` are recognised as locking clauses by walking back over their own words — precise, and it does not reintroduce the positional test round 2 removed. |
| P2 · "no diff hunk touches it" does not prove the psql control's flake is transient | Fair, and the wording is corrected: the measurement is reported (2 failures in 14 runs, consecutive, three clean runs after) and the causal claim is dropped. |
| P3 · five stale statements in comments and the runbook | Corrected: the deleted positional test, "every entrypoint calls `requireOwnedByCurrentIdentity`", five-vs-six writing paths, and the stale 75/48 · 229/229 · 3,913 figures. |

**Three of the new mutants survived first time, and all three were missing FIXTURES rather than
missing fixes** — the parenthesised compound source, the conflict clause and the subquery-before-
trainer SET had no adversarial case in the corpus, so the guard's own self-test could not see the
mutation. Adding them is the finding. (A fourth was a no-op mutant that changed nothing.)

## THE ROUND-5 STOP — five blocking findings, recorded and then remediated

**Status at the stop: the fifth and final review round was CONSUMED and NOT CLEAR.** The
envelope's discipline is `P1 after R5 → owner stop`, and its predecessor's was "no
post-final-round edits". Both say the same thing, so the five P1s below were recorded rather than
repaired at that point: a fix made after the last round carries no review, and this batch's whole
history is a record of fixes that looked complete and were not.

**Status now: all five are fixed under a separate owner approval**
(`APPROVE_D7_STAGE1_GATE_COMPLETENESS_REMEDIATION_V1`), which set its own scope, its own evidence
bar and its own review rounds. See *The gate-completeness remediation* below. The findings stay
here verbatim because the record of what a round found is not rewritten by what was done about it.

Every finding is stated as the reviewer stated it.

### P1 — blocking

1. **A nested conflict clause hides the outer conflict write.**
   `scripts/check-abc27-trainer-source-authority.mjs` — `conflictBindings()` reads the FIRST
   `ON CONFLICT` anywhere in the statement, so a data-modifying CTE can put an unrelated one first:

   Indented rather than fenced, deliberately: every SQL-tagged fence in this document is an
   operator-runnable query held to the `pg_catalog.` qualification discipline the install-window
   section describes, and the block below is an illustration of a shape the guard must refuse.

       WITH x AS (
         INSERT INTO public.other_table(id) VALUES ($3) ON CONFLICT (id) DO NOTHING RETURNING id
       )
       INSERT INTO public.availability_slots(id, trainer_id)
       SELECT $1, $2
       ON CONFLICT (id) DO UPDATE SET trainer_id = 'ffffffff-…'::uuid;


   The INSERT's own `$2` binding passes, `conflictBindings` finds the CTE's `DO NOTHING`, returns
   nothing, and the outer fixed foreign trainer is never read.

2. **The structural scope check misses element-access query calls.**
   `sendsSql()` recognises `PropertyAccessExpression` only, so `client['query'](…)` is not seen as
   sending SQL — and with the verb and the relation in separate declarations, neither the raw nor
   the squashed text carries a complete `INSERT` either.

3. **The caller-supplied-id sensor covers one of the two id-taking inserts.**
   `insertSlot` and `insertTemplateSlot` both accept `id`; only `insertSlot` has an id-specific
   refusal case. Removing `insertTemplateSlot`'s check leaves every current control green, because
   its ordinary matrix case supplies no id and rejects on the foreign trainer instead.

4. **The apply census still recognises one stored-call spelling.**
   It counts dot access of the `CALL` map key, so `CALL['rebook_round_apply_command_as_actor']`
   moves no pinned count. A direct call with whitespace before `(` is likewise invisible to the
   exact `routine(` needle. And the counts are GLOBAL, so they establish no PAIRING: moving one
   `enteringApplyWrite([], [], 'decoy')` elsewhere while leaving a real call unguarded preserves
   every number.

5. **Two exemptions on one source line collapse to one.**
   The ordinary inventory key gained the literal's start position; the EXEMPTION record did not.
   It is still keyed and deduplicated by `file:line`, so two separately-marked
   `SHARED_NAMESPACE_CONTROL` writes on one physical line are counted once and the expected count
   of one still holds.

### P2 — refinements

1. **The trainer-half matrix's key set is not pinned.** `bySubject` is compared against
   `EXERCISED`; `alsoForeignTrainer` has no expected-key assertion, so its coverage can lose one of
   the three trainer-moving setters silently.
2. **The psql resolver control remains flaky.** The wording change did not alter the control.

### What the round CONFIRMED correct

The parenthesised-source scan, the depth-aware SET terminator, the optional `MERGE INTO` handling,
the full export-key pin, both current insert-id checks, the ordinary statement inventory key, and
the locking-clause recognition. In the reviewer's words: *every currently checked-in non-exempt
factory/apply write reaches its applicable registry check; the sole direct exception remains the
deliberate `SHARED_NAMESPACE_CONTROL` write.*

### The honest reading of that

The five P1s are all about the GATES — the static guard's coverage of SQL forms nothing in this
repository writes, and the tripwires' ability to notice a future edit. None of them is a defect in
the checked-in write paths: the reviewer states, and four rounds of measurement agree, that every
non-exempt write in the suite goes through the factory and asks the registry. So the runtime half
— the load-bearing half — is where it was said to be. What was NOT yet true is the strength of the
static half against constructions a future author could write, and the tripwires' ability to catch
their own erosion. That gap is what the remediation below closes.

## The gate-completeness remediation

Approved separately after the stop, scoped to the checker, its self-test, the direct factory
refusal tests, the apply census and this record. The frozen migration, the `POST_ABC27_ALLOWED`
span and the D7 convergence files are byte-exact throughout, and nothing is committed.

| Round-5 P1 | The remedy | The control that proves it |
|---|---|---|
| 1 · a nested conflict clause hides the outer one | Every write now owns a REGION (`writeRegion`), and its clauses are read from that region **at that write's own paren depth**. `conflictBindings` takes the write rather than the statement. An `ON CONFLICT` whose action cannot be read is refused rather than assumed to be `DO NOTHING`. | Four fixtures: the reviewer's CTE verbatim; the same CTE beside a *clean* outer clause, which must still be ACCEPTED; a guarded write **inside** the CTE, audited on its own clauses; and a CTE nested **inside the write's own source**, which the region bound alone does not separate and the depth test does. |
| 2 · the scope check missed `client['query'](…)` | `sendsSql` reads three shapes — member call, literal-subscript call, and a COMPUTED member call, which cannot be shown not to be `query` and is therefore reported. It returns the reason, which the refusal now quotes. | Two more scope-drift controls: a file that sends with the subscript spelling and carries its verb and relation in separate declarations, and one whose member call is computed. The comment-only control still must NOT be reported, so the rule stays a parser rather than a substring match. |
| 3 · only one of the two id-taking inserts had an id case | Both are driven from a named `ID_TAKING` map whose key set is asserted, each with a slot another test owns. | The refusal matrix, extended; a third id-taking entrypoint cannot arrive without a case. |
| 4 · the apply census counted, and counting establishes no pairing | **The census is gone and replaced by a walk of the syntax tree.** For every `.query(…)` it resolves the first argument through literals, templates, `+`, `const` bindings, `for … of` tuple destructuring, and property **or subscript** access into an object literal — which is how the stored `CALL` map is reached in either spelling — and then asks whether an `enteringApplyWrite` runs **earlier in that call's own function**. A computed subscript into a map that holds a writing routine's call text is reported. Names resolve LEXICALLY: the innermost declaration whose scope contains the reader, because a 30,000-line file declares `sql` and `calls` many times. | The census is a function of the source text, so it is run against four mutated copies of this file *inside the test itself*: a guard deleted; a guard **moved to another scope** (the exact defect counting could not see — the number of guard calls is unchanged); an unguarded subscript invocation of the stored call text placed **before** that test's own guard; and a computed subscript into the stored map. The inventory it pins is the list of DRIVER LABELS each call was paired with, not line numbers. |
| 5 · two exemptions on one line collapsed to one | The exemption record and its inventory key carry the literal's start **and the marker comment's own byte offset**. | A fixture with two separately-marked exempt writes on ONE physical line, asserting two exemptions. |

**Six mutants, one per remedy (P1.1 gets two — the region bound and the depth test are separable),
each aimed at the control that proves THAT remedy rather than a neighbouring gate.** All six
discriminate. Three of them initially SURVIVED and every one was the mutant or the fixture being
wrong rather than the remedy: `R5-1` did not restore the original defect (the region bound alone
already covered the reviewer's shape, which is how the nested-CTE fixture came to exist), and
`R5-5`'s two writes started on different physical lines, which is not the defect at all.

**One defect the remediation's own fixtures found**, and it is worth naming because inspection did
not: with the conflict clause finally being read, an INSERT of the form `SELECT $1, $2 ON CONFLICT
…` had no `FROM`, so the projection's terminator ran to the end of the statement and swallowed the
whole conflict clause into the trainer's projection item. The projection now ends at the first
clause keyword at its own depth.

**And a tool defect worth recording**: six battery anchors had gone stale across the remediation's
own edits, and the battery discovered that one expensive sensor run at a time. It gained an
`--anchors` mode that applies and restores every mutation without running a sensor, and reports
which no longer match — seconds instead of hours. All 49 anchors apply.

### The post-review documentation, reviewed in this batch

Two things were written after round 5 and so carried no review. Both are in scope here and both
were re-read against the code:

- **The round-5 record** above is accurate as a statement of what the reviewer found, and its
  status line is corrected: the findings are no longer "deliberately NOT fixed", and saying so
  while they were fixed would have made the document lie about its own subject.
- **The fence retag.** The illustrative SQL in finding 1 was originally written as an SQL-tagged
  fence, which broke `the rollout guide and the migration agree about the installation window` —
  every SQL-tagged fence in this document is an operator-runnable query held to a `pg_catalog.`
  qualification discipline, and an illustration of a shape the guard must refuse is not one. It is
  indented instead, the reason is stated at the block, and the document has nine SQL fences, none
  of which carries an unqualified name. That test is green.

## THE ROUND-6 REVIEW — seven findings on the remediation's own gates

The gate-completeness remediation was reviewed in a fresh thread. It returned **seven findings,
all P1, and no P2 or P3** — and every one was a claim the gates made that the implementation did
not support. None of them was in a write path: the write surface itself was confirmed again. They
were all in the readers that certify it, which is the same class of defect round 5 found and the
reason a second closure round exists at all.

Each was checked against the source before being acted on, and all seven held.

### The seven, and the eight changes that closed them

1. **The alias resolved outside the region.** Round 5 bounded a write's CLAUSES to its own region.
   The ALIAS one of those clauses resolves through was still sought across the whole statement, so
   a data-modifying CTE declaring `unnest($1::uuid[]) AS t(id)` made an outer `INSERT … SELECT
   t.id FROM public.trainer_profiles AS t` read as parameter-bound while the trainer really came
   from the table. `unnestBindings` now takes the region and reads only bindings at the write's
   own paren depth inside it. The `unnest` series statements the factory really uses sit at that
   depth and still pass, which is the acceptance half of the evidence.

2. **A valid UESCAPE spelling failed OPEN.** The lexer threw on any escape character but the
   default. That was not a mis-read, it was a hole: the catch that surrounds the lexer asked its
   fallback question of the UNDECODED text, so `U&"availability!005Fslots" UESCAPE '!'` — an
   ordinary PostgreSQL spelling of the guarded relation — threw, carried no contiguous table name
   for the fallback to find, and was reported as nothing at all. UESCAPE is decoded now, and a
   clause that is genuinely unreadable (an escape character that is not one character, or none at
   all) still throws.

3. **The lex-failure fallback read raw characters.** The same finding's other half, and the more
   general one: `text.includes('availability_slots')` is exactly the question the lexer exists to
   stop anyone asking. A text that fails to lex is now re-read with every terminator relaxed and
   its DECODED tokens are asked instead, recursively through dollar-quoted and string bodies; a
   text that cannot be read even then is refused outright.

4. **A send bound away from its call site was invisible.** `checkScopeDrift` asked "does this file
   CALL `.query`". `const send = client.query.bind(client)` followed by `send(text, values)` has
   `bind` as one callee and a bare identifier as the other, so neither call answered yes — and
   with the verb split across declarations no text match reached it either. The question is now
   "does this file OBTAIN `query`": a member read in any spelling, a destructuring of one, and a
   computed member, which cannot be shown not to be `query`. A numeric subscript cannot name a
   member and is not reported, so this did not become a ban on subscripting.

5. **Exemption identity collided one level down.** Round 5 gave each exemption the marker's own
   byte offset. The recursion into a dollar-quoted body reused the OUTER literal's start while
   each marker position is body-local, so two bodies in one literal with their markers at the same
   offset inside themselves produced one record — the same collapse, one nesting level deeper. The
   body token's position composes into the site.

6. **The census fell open on templates and on stored call text.** Two shapes: a template's holes
   were discarded, so a query whose whole text arrived through one composed to an empty string, named no routine and
   was neither paired nor reported; and a map was judged dangerous by its KEY NAMES, so the
   writing call text filed under `{ apply: … }` and reached by a computed subscript resolved to
   nothing. Holes are resolved now (an unresolvable one contributes its own source text, and a
   product this cannot enumerate is reported rather than sampled), and a map is judged by what is
   IN it.

7. **"Earlier in the same function" is not "runs before".** `guardBefore` searched the whole
   enclosing function and compared source offsets, so a guard inside a nested arrow nothing calls,
   or behind a branch never taken, was counted. It now demands dominance: the guard is in the
   call's own body (nested functions are not entered) and every ancestor between it and that body
   always evaluates. Getting this right required one correction — `(guard(), await query).rows[0]`
   is a real shape here, and a member access carries the guard only from its OBJECT side.

8. **The id-taking inventory was remembered, not derived.** `ID_TAKING` was compared against a
   second hard-coded list, so a third id-taking entrypoint could join the export pins, the refusal
   matrix and the byte-equality driver while never appearing there. The list is now derived from
   the factory's own declarations — every exported callable, every parameter that is not the
   connection, and the object shape it declares — and a parameter shape the reader cannot resolve
   is reported rather than assumed to carry no id.

That is seven findings closed by eight changes; finding 2 needed two, because refusing to read a
construct and failing open on the text are different defects with the same cause.

### The evidence

Nine mutants, one per remedy, each reverting the REMEDY rather than breaking a neighbour, and each
naming the single sensor that must go red: `R6-1` the CTE-alias fixture, `R6-2` the ACCEPTANCE
control that names another relation (which is what separates decoding from a blanket ban), `R6-3`
the unlexable-but-still-names-the-table fixture, `R6-4` the alias scope-drift file (whose verb is
split so no text match reaches it either), `R6-5` the two-bodies-in-one-literal fixture, `R6-6`
`R6-7` `R6-8` the census's own template, stored-map and dominance mutants, and `R6-9` a third
entrypoint that acquires a caller-supplied id while the export surface, the statements and the
refusal matrix all stay exactly as they were — so only a derived list can notice it.

The corpus is now 71 fixtures and 109 assertions; the census carries eight in-test mutants; the
battery is 58 mutants and every anchor applies.

**One cost the round-6 mutants really did impose**, and it is recorded rather than absorbed: the
census's name resolver walked the whole 30,000-line file for every identifier it was asked about.
That is quadratic, and it was affordable while the census ran five times; at nine it took the test
past its 120-second timeout — twice, on an idle machine, so it was a real cost and not a flake. The
declarations are indexed by one walk now and the lookup rule is unchanged (the innermost
declaration whose own scope also contains the reader). Measured on the same bytes: 45 s before,
1.4 s after, with identical verdicts on the real file and on all eight in-test mutants.

### The second review pass, and the eight further findings

The remediation above was reviewed again. **Eight findings, all P1, no P2 and no P3** — and the
pass explicitly confirmed four things correct that it had been asked to attack: the declaration
index is equivalent to the walk it replaced, the region-bounded `unnest` lookup is right, the
recursive exemption-site composition is right, and the object-side rule in `dominates` is right.

The eight were all cases of a remedy recognising the shape it was built around:

1. **A comment is whitespace.** `U&"availability!005Fslots" /* c */ UESCAPE '!'` is one construct
   in PostgreSQL, and skipping only `\s` decoded it with the DEFAULT escape and then read
   `UESCAPE` as an unrelated word — a different identifier entirely. Whitespace and comments are
   skipped alike now.
2. **The over-bound arm still read raw characters.** Fixing the lex-failure fallback left its twin
   untouched: a literal that expands past the bound is never lexed, and the arm deciding what to
   do about that asked `includes('availability_slots')`. Both arms decode before they answer.
3. **A quoted or computed destructuring obtains `query` too.** `const { 'query': send } = client`
   was invisible; a computed one cannot be shown not to be `query` and is now reported.
4. **An unresolved template hole must not contribute its own source text.** Doing so made
   `c.query(<a hole>)` read as the harmless expression it is written as. A hole is one atom now.
   Reporting EVERY unresolved hole was measured first and reports 101 of this file's ordinary
   interpolated statements, which is why the rule is positional: a hole may stand where a value
   goes, and may not be the whole text, stand before the statement's verb, or stand where a
   `FROM`/`JOIN` target belongs.
5. **A binding that can be assigned again is not a text.** `let sql = harmless; sql = writing;
   query(sql)` was read as its initializer. Only a `const` is followed.
6. **A `try` ancestor is not automatically dominance — and is not automatically a refusal
   either.** Listing `TryStatement` as unconditional let a guard whose query sits after the
   `catch` count; deleting it unguarded three real sites where the guard and the query share the
   block. The rule is containment: a conditional ancestor is accepted only when the child the walk
   came through also contains the guarded call. That is the same answer for `if`/`else`, loops and
   `?:`, and it is what the construct list was a poor approximation of.
7. **Dominance is not value-pairing, and the claim now says so.** This reader establishes that a
   guard RUNS before each writing invocation, not that it was handed that invocation's own slots.
   What refuses a foreign slot is `enteringApplyWrite` at run time and the drivers' own
   `assertSourceSlotsOwned`. The one degradation the reader CAN see is now pinned: a guard handed
   an empty array is labelled `(guarding no slots)` in the inventory, and exactly one label in
   this file is entitled to that.
8. **An inherited or quoted option property evaded the id derivation.** `interface SpecialSlot
   extends BasicSlot {}` has no members of its own, and `{ 'id'?: string }` is not an identifier
   name. Heritage is followed, quoted names are read, and a base this module does not declare
   makes the shape UNREADABLE rather than empty.

**Three statements in the suite are genuinely unreadable to the census, and they are now pinned
rather than tolerated**: two build their `FROM` target from a catalog name the running server
chose, and one splices a function definition around a hole. None is an apply path, and a fourth
turns the control red.

Eight more mutants, eight discriminating — including two that had to be re-aimed because the first
attempt would have been caught by a neighbouring gate (a new export moves the export-surface pin,
so the id-derivation mutant uses an INTERFACE, which is erased at run time and therefore invisible
to every other control). The corpus is 75 fixtures and 115 assertions; the census carries eleven
in-test mutants; the battery is 66 mutants and every anchor applies.

## THE ROUND-6 STOP — the third review pass, and six findings left open

The review budget for this batch was three passes in one thread. The third returned **six
findings, all P1, no P2 and no P3**, and the batch STOPS here rather than editing gate code that
no round is left to read. That is the same rule the round-5 stop followed, and for the same
reason: gate code written after the last review is gate code with no review, which is precisely
the condition the last two closure rounds existed to repair.

The pass confirmed correct, having been asked to attack them: `skipBlanks` (the main lexer
revisits an unterminated comment and rejects it, and strict mode rejects a missing escape literal
immediately), the containment rule in `dominates` including its `child.pos <= at && at < child.end`
test, the object-side allowance for property and element access, quoted names and locally-declared
generic bases in the id derivation, and unresolved alias bases as fail-closed.

**The six that remain open.** Each was checked against the source before being written down here,
and all six hold:

1. **The over-bound arm decodes SQL escapes but not JAVASCRIPT ones.** `tolerantlyNamesTable`
   receives raw TypeScript source, so a literal that exceeds the expansion bound and spells the
   relation as `public.availability_slots` is decoded by the runtime and by nothing else. Under
   the bound this is caught, because the expander reads the COOKED text; over it, the arm reads
   `getText()`. The round-2 fixtures prove `UESCAPE`, not the source language's own escapes.
2. **The positional hole rule is raw-text matching.** `VERB` matches a verb written in a COMMENT,
   so `` `/* SELECT */ ${hole}` `` reads as a statement whose hole is in a value position; and
   `FROM_TARGET` accepts only an unquoted schema, so `FROM "public".${hole}(` is certified.
   Comments, `LATERAL` and other legal separators create the same class of miss.
3. **A quoted routine identifier evades the census entirely.** `invokedBy` matches only an
   unquoted `public.` and an unquoted routine name, so a new UNGUARDED
   `FROM "public"."rebook_round_apply_command_as_actor"(…)` moves none of the three lists and the
   seven-item inventory stays green. This is a pre-existing property of `invokedBy` that the
   round-6 work did not introduce and did not close.
4. **A stored call map is judged harmless when its VALUE cannot be resolved.** `{ apply:
   getWritingSql() }` makes `isStoredCallMap` return false rather than reporting, so a computed
   subscript into it resolves to nothing. "A map is judged by what is in it" is true only for
   values this reader can already resolve.
5. **`(guarding no slots)` recognises only a bare `[]` node.** `([] as unknown[])`, `[...[]]`,
   `Array.of()` and a named `EMPTY_SLOTS` all hand the guard nothing while keeping the ordinary
   label, so the inventory does not move.
6. **Interface DECLARATION MERGING loses the earlier declaration.** The derivation's map keys on
   the name and the last `interface X` wins, so a shape that declares `id` in its first
   declaration and something else in its second is read as carrying no id — and an entrypoint
   taking it can be omitted from `ID_TAKING` without becoming unreadable.

Findings 1, 2, 4, 5 and 6 are all the same shape as every finding of the last two rounds: a reader
that answers a question it cannot actually decide, in a direction that certifies. Finding 3 is
older than this batch. None of the six is in a WRITE path — the write surface and the runtime
registry were confirmed again — and none of them changes what the suite does today.

**The gates are green on the stopped bytes**, which is what makes them a coherent starting point:
guard ✓, self-test 115 assertions over 75 fixtures, `eslint .` 0, typecheck 82/82 baseline, CI
contract ✓, edge-pins/edge-config/legacy-key ✓, build ✓, unit 392 files / 3,956 tests,
`d7ForwardChain` 38/38, the db suite 230/230 with eight of nine runs clean, 66 battery mutants with
every anchor applying and all nineteen closure mutants discriminating, and an exact double re-pin.

**One intermittent failure is recorded rather than hidden.** One db run in nine failed `barrier
10b: the lifecycle writer consumes BEFORE its first product row lock`. It sits at line 19077 and
runs BEFORE anything this batch changed; none of the 113 diff hunks touches its region; and it did
not reproduce in the eight further runs, so its message was never captured and it is NOT
characterised. It is not one of the three recorded load-sensitive controls, and nothing about it
has been widened or hidden.

## THE CERTIFIER-READER BATCH — a canonical parser instead of a sixth patch

Approved as `D7_STAGE1_CERTIFIER_READER_PARSER_AUTHORITY_IMPLEMENTATION_V1`, scoped to the guard
script, its self-test corpus, the census (extracted to a module), the factory's runtime test, the
`package.json`/lockfile entry for the parser, and this record. The frozen migration
(`05e04451f944cabf`, 20,633 lines), the `POST_ABC27_ALLOWED` span, the D7 convergence files and
**`abc27SlotFixtures.ts` / `abc27TrainerAuthority.ts` in their entirety** are byte-exact
throughout. Nothing is committed.

### Why the shape of the work changed

Four rounds in a row stopped on the same mode, and never in a write path: *a reader that answers a
question it cannot actually decide, in a direction that certifies.* Each round patched the shape
the reviewer used; the next round found the neighbouring shape. Every instance was a hand-written
stand-in for PostgreSQL's grammar — `FROM (public.)?routine(` cannot see `FROM "public"."routine"(`;
a `VERB`/`FROM_TARGET` pair over whitespace-squashed text reads a hole after a block-commented verb
as verb-then-value; a positional column/value walk needs a new rule for every spelling the grammar
admits.

So the enumerations that stood in for the GRAMMAR are gone — every question about what a statement
IS now goes to PostgreSQL's own parser. Two enumerations remain and are named as such rather than
claimed away: which parse-tree fields carry a routine's name, and which PL/pgSQL statement kinds
are entirely fixed. Neither has a grammar to ask; both fail closed and both are stated at their own
site. **`libpg-query@18.1.4` — the real PostgreSQL parser (libpg_query), compiled to WASM — is now
the single decoder**, asked by both readers through one shared module,
`scripts/abc27ParseOracle.mjs`. Its raw parse needs no catalog, so the same call answers in the
plain-node CLI, in the vitest unit project and in the db project. The grammar it reports (`180004`,
the PG18 line) is the same server family the db suite boots (`embedded-postgres@18.4`), and the
guard prints it on every run so a library bump is visible in the gate's own output.

**Adoption was fail-closed and was measured first.** All twenty `SLOT_STATEMENTS` constants parse
to exactly one statement each; the two plants parse as `CreateFunctionStmt`/`CreateTrigStmt`; the
drift function's dollar-quoted body is read with `parsePlPgSQLSync` and its `UPDATE` comes back as
its own text, audited by the same oracle. The named Plan B was not needed.

### The invariant, stated once and now tested

> Every classification returns decided-yes, decided-no, or UNREADABLE, and *unreadable* always
> surfaces — as a violation, a pinned identity, or a red control. No reader maps "cannot read" onto
> the certifying side.

It is no longer a convention for the functions that ANSWER a classification: `abc27ApplyCensus.ts`
tags each `@classifier`, `CLASSIFIER_PROBES` drives one genuinely undecidable input through each,
and the control derives the list **from the module's own source**, so a tagged classifier without a
probe is red rather than invisible.

**And the honest limit of that control, which round 4 named**: it derives only what the author
tagged. The helpers those classifiers are built from — `resolveNode`, `objectMember`,
`literalMember`, `declarationFor` — are not tagged, and several P1s of rounds 2 and 4 lived in
exactly those. The probes prove the top-level arms surface an undecidable input; they do not prove
the helpers do, and the mutation battery rather than the probe derivation is what covers those.

### The six P1s and the seventh, each with the control that proves it

| # | The remedy | The control |
|---|---|---|
| A1 | The over-bound arm stops asking a question it cannot answer: exceeding `MAX_EXPANSIONS` is now an **unconditional refusal**, in the factory and outside it alike. `OVER_BOUND` is a distinct answer from "unresolved", which they were not before. | Measured first: **zero** over-bound literals exist in the five guarded files, so nothing legitimate pays. Three fixtures — an over-bound literal spelling the relation through a **JavaScript** escape (the shape `node.getText()` could not see); the same literal naming another relation, whose verdict **flipped from accept to refuse** and says so; and a 64-expansion composition at the bound, which is accepted, so what refuses is exceeding the bound and not composing. |
| A2 | The `VERB`/`FROM_TARGET` pair is replaced by the **sentinel parse protocol**: every hole becomes one bare sentinel word, the text is parsed, and each sentinel is classified BY THE PATH THAT REACHES IT — a `funcname` (the hole decides which routine is invoked), a `DO`/`CREATE FUNCTION` body (text the server re-parses), or inert. A sentinel that is not in the tree at all was **erased** — a hole inside a `--` comment, whose runtime value can end the comment — and erased is unreadable, not harmless. | Three in-test mutants: a hole that is the whole statement behind a block-commented verb; a hole naming the routine behind a **quoted** schema; and a hole inside a line comment. |
| A3 | `invokedBy` reads the parse tree. Quoting, case and schema are the parser's problem, and a routine name inside a string constant is not an invocation. | Two mutants: an unguarded invocation spelled `FROM "public"."rebook_round_apply_command_as_actor"(…)`, which the old anchor could not see at all; and the **near name** `…_lifecycle_command_as_actor`, which must stay unreported or every verdict above means nothing. |
| B4 | `classifyStoredCallMap` is tri-state. A literal map — object **or array** — with any value this cannot resolve is `undecidable`, and a computed subscript into it is reported. The ARRAY half was narrower than that read for two more rounds: a numeric index was taken as a syntactic position, which is a runtime position only while no earlier element spreads. | A mutant storing an unresolvable call (`{ apply: getWritingSql() }`) behind a computed subscript. The acceptance half is measured on the real file: `rows[0]`-class subscripts stay unreported. |
| B5 | `classifyGuardSlots` answers in three values — provably-empty (through parens, `as`, `satisfies`, spread-of-empty, and a `const` this can follow), ordinary (an array literal with elements, a property access, a **parameter**), and everything else, which gets its own label `(guarding an unprovable slot list)` **pinned to zero occurrences**. Choice forms (`??`, `||`, `? :`) are combined arm by arm. | Four mutants, one per defeating spelling. The `??` handling was found by measurement, not inspection: without it the file's healthiest guard — `(o.slots as string[]) ?? ser.slots` — read as unprovable. |
| B6 | The id derivation keys each name to **all** its declarations and unions their members — interfaces, type aliases and, after round 4, classes, which merge with an interface of the same name; an unreadable member in any declaration makes the shape unreadable. The derivation is now a pure function of source text, so it runs against mutated copies while the factory stays byte-frozen. | Three mutants: a second declaration that hides the first; an unreadable member in the LATER declaration; and an id declared only in a later merged declaration, so the union reads every declaration rather than preferring one. |
| §1 "7th" | The unreadable pin is keyed by **content identity** — `sha256(category \| normalized text with hole atoms)`, first 16 hex — and the control asserts exact SET equality plus a per-identity category. | A mutant that makes one pinned unreadable readable and introduces a NEW one of the same category, so the count and the reason strings are unchanged. Under the retired reason-count pin this was invisible. |

### R5 — the structural reason none of the six was ever a live defect

New checker rule, pinned in both directions: `abc27TrainerAuthority.ts` imports only `vitest`,
`node:crypto` and `pg`; `abc27SlotFixtures.ts` only `pg` and the authority module. Neither may
import the checker, the census or anything under `scripts/` — in any spelling, including
`export … from`, `require`, and a **computed** `import()`, which cannot be shown not to be the
checker. Eleven controls drive it, two of them against the real modules, so the acceptance half
is a claim about the tree rather than about a fixture.

### The measurement gate fired, and the protocol was reconsidered twice

§4 of the envelope set its own tripwire: *if the pin list exceeds ~10 entries, stop and reconsider
the protocol rather than shipping a pin-blanket.* The first form of the sentinel protocol — a
string-literal pass, then a quoted-identifier pass, classified by whether every sentinel was a
string constant — surfaced **ninety** unreadables on the real file. That is a blanket, so it was
reconsidered:

1. **One bare atom instead of a ladder of quoted attempts.** A plain lowercase word is legal
   wherever an identifier is, wherever an expression is, inside a string constant, and as part of
   a longer identifier — which covers `'\x${hex}'::bytea`, `abc27_drift_${suffix}` and
   `ARRAY[${list}]` in one pass. 90 → 23.
2. **Classify the POSITION, not the spelling**, and descend into PL/pgSQL bodies with the same
   oracle rather than refusing at their edge. 23 → **16**.

Sixteen is over the estimate and is recorded as such rather than argued away. Every one is a text
a canonical PostgreSQL parse genuinely cannot fix — a hole in a keyword (`BEGIN ISOLATION LEVEL
${…}`), in a whole clause (`ADD CONSTRAINT ${name} ${definition}`, `VALUES ${row}`,
`EXPLAIN (…) ${stmt}`), in a routine name, or in a body the server re-parses — plus one text with
no hole at all (`CREATE ROLE public NOLOGIN`, which PostgreSQL's own grammar refuses, agreeing
with the server) and one computed subscript into a map of `pg_get_functiondef` results.
**The predecessor certified thirteen of the sixteen.** Each carries a one-line rationale in the pin
table, and the unit of justification is the SHAPE: nine `DO $abc27_owner_final_recheck$${body}$`
occurrences are one identity and one rationale, and occurrence counts are deliberately not pinned
so the control does not churn on unrelated edits elsewhere in a 30,000-line file.

**One acceptance the envelope predicted did not survive measurement, and is recorded rather than
worked around.** §3's B4 note listed `shippedDefs[which]` among the subscripts that stay
unreported. It does not: `shippedDefs` is an object literal whose two values are `await`ed catalog
reads, so under B4's own rule ("any property value unresolvable or COMPUTED ⇒ undecidable") the map
is undecidable and the computed subscript is reported. Certifying it would be the exact collapse
this batch removes, so it is pinned with its rationale instead.

### What the hand lexer keeps, and why the two readers do not overlap

The SQL lexer is **not** retained beside the oracle as a second certifier. It keeps exactly its
tripwire duties over INCOMPLETE texts, where its claims already fail toward reporting: does a
literal name the table beside a write verb, is there an exemption marker, does a sibling file
obtain `query`. For a factory literal, the lexer's write count and the oracle's own write-set both
DECIDE WHETHER TO AUDIT — either is enough — and only the oracle decides what the audit says. A
detector that over-reports costs an audit that passes; a certifier that over-reports is a hole, and
there is exactly one certifier.

**Deleted, not retained beside the oracle** (a retained undecidable reader is future P1 surface):
`auditFactoryWrite`, `trainerBindings`, `conflictBindings`, `classifyTrainerExpression`,
`unnestBindings`, `writeRegion`, `depthAt`, `topLevelSplit`, `stripCasts`, `paramIndex`,
`qualifiedRef` — 144 lines of re-implemented grammar.

**One widening was written and then removed for lack of a sensor.** The unresolved-composition arm
was changed to ask its question of COOKED literal parts as well as raw source; measurement showed
it adds no discrimination, because every string operand of an unfoldable assembly is already
visited and cooked on its own one node down. The arm keeps the raw question, and the comment now
says precisely why that is the right question there — the assembled text was never formed, which is
the folding residual the honest claim already names.

### Review round 1 — the checker half, and what it found

Round 1 ran `gpt-5.6-sol` at `ultra` over the oracle, the guard and the guard's unit suite. The
MCP call timed out at 1800 s without returning; the findings were recovered from the session
transcript, which is the recorded recipe for that failure and is not a review verdict. **Five
findings, four of them P1, and every one reproduced before it was fixed.**

| Finding | What it was | The remedy, and its sensor |
|---|---|---|
| P1 · a schema-qualified `unnest` lookalike | `unnestAliases` matched only the LAST element of the function name, so `FROM evil.unnest($1) WITH ORDINALITY AS t(id, i)` was read as PostgreSQL's built-in and `t.id` certified as a parameter-bound trainer. An arbitrary set-returning function supplied the trainer while the audit called it bound. **Reproduced: 0 violations.** | Only the unqualified spelling and `pg_catalog.unnest` are the built-in. Fixture `g2-unnest-lookalike-in-another-schema`, acceptance twin `g2-unnest-catalog-qualified`, battery mutant `M26`. |
| P1 · a body that BUILDS its statement | `EXECUTE format('UPDATE public.availability_slots SET trainer_id = %L …', …)` inside a factory function body: every FIXED text in the body is harmless, the expression collected for the dynamic statement is `format(…)` whose write-set is empty, and both detectors saw nothing. **Reproduced: 0 violations for a real UPDATE with a literal trainer.** | The body's statement KINDS are read against an allow-list, so every dynamic form — `EXECUTE`, dynamic `FOR`, a dynamic cursor `OPEN`, `RETURN QUERY EXECUTE` — is refused without this file enumerating them. A listed kind carrying a `dynquery` is refused too, which is what separates `RETURN QUERY <fixed>` from `RETURN QUERY EXECUTE`. Fixture `g2-dynamic-execute-in-a-function-body`, mutant `M27`. |
| P1 · hole-free bodies were never opened | The census descended into a body only when a substituted atom had landed in one, so `DO $$ BEGIN PERFORM rebook_round_apply_command_as_actor(); END $$` — no hole at all — was neither paired nor reported: a raw parse does not look inside a body. | The body is read whenever there is one. In-test mutant `an unguarded invocation inside a body that carries no hole`, battery mutant `M29`. |
| P1/P2 · routine names outside `funcname` | PostgreSQL carries a routine's name as `ObjectWithArgs.objname` wherever a statement refers to a function rather than calling it, and inside a `DefElem` for `SFUNC`, `HANDLER`, `PROCEDURE`, a cast's or a transform's function. All read as inert. | `objname` names a routine; a `DefElem` is an option this tree does not interpret and is a nested source. In-test mutant `a hole naming the routine outside funcname` — deliberately an `objname`-ONLY shape (`DROP FUNCTION public.${hole}(int)`), because a `CREATE AGGREGATE … SFUNC` hole lands in a `DefElem` too and would let the `objname` rule be reverted with the mutant still passing. Battery mutant `M30`. |
| P1 · a Node loader with no import spelling | `process.getBuiltinModule('node:module').createRequire(import.meta.url)('./abc27ApplyCensus.ts')` loads a module, and a rule that read import declarations and `require`/`import()` calls reported nothing. The TYPE position `import('…').T` was missed as well. | Both are read, and obtaining a LOADER is reported with an unreadable specifier. Two more R5 controls and battery mutants `M31`/`M32`. **And the claim is corrected rather than patched**: this is an enumeration of spellings, which is the shape this batch removed everywhere else, and there is no grammar to ask instead. R5 is therefore stated as DEFENCE IN DEPTH — what actually keeps a reader's verdict out of a runtime decision is that no runtime module consults one, since the checker and the census produce assertions and exit codes and never a file, an env var or a config. |
| P3 | `expansionsOf`'s doc said `null` means over-bound; it has meant "could not be folded" since `OVER_BOUND` became its own answer. | Corrected. |

**Two more defects surfaced while fixing those, and both are recorded because nothing else would
have caught them.**

- **A `LANGUAGE sql` body made the descent return zero statements, and zero was being read as
  "nothing in the body".** `parsePlPgSQLSync` SUCCEEDS on `CREATE FUNCTION … LANGUAGE sql AS
  'UPDATE …'` and returns no queries at all. The body is plain SQL, so it is now parsed directly
  and audited like any other statement — read rather than refused, which also keeps the pin list
  from filling with ordinary `LANGUAGE sql` probes. Fixture
  `g2-sql-language-body-writes-the-relation`, mutant `M28`.
- **The mutation harness was silently mangling its own mutants.** `String.replace` gives `$&`,
  `` $` `` and `$'` special meaning IN THE REPLACEMENT, so any mutant carrying dollar-quoted SQL —
  `DO $zz$ … $zz$'` — was spliced with a copy of the surrounding file instead of with itself. Two
  of the new mutants were VACUOUS while still differing from the original, which is exactly what
  the "the mutation must really apply" check was supposed to prevent. Every splice now goes
  through a replacer FUNCTION, and every mutant carries the exact text that must be PRESENT
  afterwards — or, for a deletion, must occur one time FEWER, because these mutants edit the very
  file they live in.

The pin list moved from 16 identities to **21**. All five additions are bodies that reach the
server through `EXECUTE`, and every one of them was READABLE to the predecessor.

### Review round 2 — the census half, and the eight wrong answers it found

Round 2 ran the same model over `abc27ApplyCensus.ts`, the census region of the realpg suite, and
the id derivation. It also timed out at the MCP boundary and was recovered from the transcript.
**Its findings are the sharpest of the batch, because they are not "this reader cannot see X" but
"this reader ANSWERS X, and the answer is wrong."** A missing text is a residual; a wrong text is a
defect. Every counterexample below was reproduced before it was fixed, and re-run after.

| Finding | The wrong answer | The remedy |
|---|---|---|
| P1 · a reassignable object map | `resolveBinding` demanded a `const` before believing a text; `resolveNode` — which follows a name to the OBJECT it denotes — did not. `let M = { sql: 'SELECT 1' }; M = { sql: <writing> }; c.query(M.sql)` answered with the harmless initializer. Census empty. | `resolveNode` is three-valued: a binding it cannot follow is `UNREADABLE_NODE`. Round 4 then found a caller that still read the sentinel as harmless — the loop resolver, where it fell through to `null` one line later — so "every caller" was a claim before it was true. |
| P1 · a later spread overwrote the key | `{ sql: 'SELECT 1', ...{ sql: <writing> } }` denotes the WRITING text; `objectMember` returned the first match. Census empty. | A spread or a computed key makes the lookup undecidable, and a repeated key resolves to the LAST writer. |
| P1 · `var` read as block-scoped | The resolver picks the declaration with the smallest enclosing scope. Giving a `var` the block it is written in makes its scope look smaller than it is, so a reader outside that block matched an OUTER `const` of the same name. Census empty. | `scopeOf` gives a `var` its enclosing function. And two declarations tying on span are no longer resolved by "first found" — a tie is undecidable. |
| P1 · a loop's value set silently truncated | `const cases = [['safe', 'SELECT 1'], dynamic()]` yielded only the safe text: the unreadable element was SKIPPED. An incomplete set is a wrong one. | Any element this cannot fold makes the binding undecidable. `null` and `undefined` arms stay DECIDED — they carry no statement — which is what keeps the file's own `[['shipped', null], …]` off the pin list. |
| P1 · a hole's JavaScript read as SQL | The residual "does the hole's own source name a routine" returned that SOURCE as the statement. `${SELECT('SELECT rebook_round_apply_normalized_core()')}` hands back `SELECT('SELECT …')`, which PostgreSQL reads as a SELECT of a string constant invoking nothing while JavaScript produces the writing statement. Census empty. | The hole becomes undecidable, and the residual question moved to where it belongs — the ARGUMENT's own source, in every branch, where a hit REPORTS the routine instead of being parsed. |
| P1 · a wider residual than documented | `resolveNode` did not unwrap `satisfies`, `!` or a type assertion, and its depth limit returned "not a literal". All three certified. | All three unwrapped; the depth limit is undecidable. |
| P1 · an empty guard arm that always wins | An array is truthy, so `empty \|\| [slot]` yields `empty` — and combining an empty arm with an ordinary one AS ORDINARY certified exactly the arm that is handed over. `({ slots: [] }).slots` and a parameter defaulting to `[]` were ordinary too. | A MIXED choice is `unprovable`; a property access is followed when its object is a literal; a parameter whose default is not ordinary is unprovable. |
| P1 · the marker was prefix-free only against itself | A statement that already spells `abc27holeatom0end` lends its occurrence to a hole the parser erased. | A text containing the marker cannot be measured with it, and says so. Asserted directly. |

**And four pin rationales were wrong, which matters as much as the code.** A pin whose prose
misdescribes what it pins is a pin nobody can re-justify:

- `83f6acb926d8b7ad` — the hole is `opts.extraSet ? \`, ${opts.extraSet}\` : ''`, an ARBITRARY
  EXTRA `SET` FRAGMENT, not the `::type` cast the rationale claimed. The residual is now stated:
  a caller supplying a writing subquery there would not move this identity.
- `6aee4b252c7ba987` — said the encoding block "writes nothing". It is the SHIPPED migration's
  encoding block run against a deliberately hostile `search_path` where a planted DOMAIN CHECK
  writes `public.abc27_shadow_witness`, and the test MEASURES that write to prove the vector is
  real. It writes. To a witness table on a disposable database, never to an apply relation.
- `5fc5d72dfc31d38f` — said the script's last statements are the dynamic `DO` blocks; it ends with
  two `RESET`s and merely CONTAINS them.
- `523d8c12498aab26` — said the fact probe "rolls back"; one identity covers several call sites and
  not all of them do. The rationale is now the shape, not a transaction claim.

Two more prose errors were corrected: a comment naming `shippedDefs[which]` as an unreported
residual when the code reports it and pins it, and a count that still said sixteen identities.

### Review round 3 — the composed whole, and five more P1s

Round 3 read both halves together, plus this record. It returned **five P1s and a cluster of
record-parity P3s**, and every counterexample reproduced.

| Finding | The wrong answer | The remedy |
|---|---|---|
| P1 · a body inside a body | The PL/pgSQL descent read what a body CONTAINS, not what those contain. `DO $outer$ BEGIN DO $inner$ BEGIN PERFORM writing(); END $inner$; END $outer$` hands the inner `DO` back as a text whose raw parse shows a `DoStmt` and no call at all. The census read it as clean, and the guard had the matching G2 escape — a literal-trainer `UPDATE` in the inner body, with the 19-site inventory unmoved. | The descent recurses, bounded, in the shared oracle so both readers get it. In-test mutant, an `ORACLE_CASES` control, and battery `M39`. |
| P1 · handler positions read as inert | `CreateAmStmt.handler_name`, `CreatePLangStmt.plhandler` and `CreateConversionStmt.func_name` are neither `funcname` nor `objname`, and each binds a function the server will RUN. The round-1 comment claimed these were covered; they were not. | Five fields added, and the comment now says plainly that this is an enumeration over the PG18 node set with a named residual, because unlike the grammar questions elsewhere there is no parser to ask "is this field a routine name". Mutant `M40`. |
| P1 · the walks truncated silently | Both shared walks simply RETURNED past their depth cap, turning "I did not look this far" into "there is nothing there". A hundred nested data-modifying CTEs parse fine and reported **zero writes**. | The cap throws, and both callers report it. |
| P1 · `resolveText` still failed open | Round 2's fix went to `resolveNode`; the path query arguments actually take kept `null` past its depth bound and did not unwrap `satisfies` or a type assertion. A seven-alias chain and `Q satisfies string` both produced an entirely empty census. `resolveText` is now tagged `@classifier` and has a probe, which is also what the "every classification" claim needs to be true. | Mutants `M42`, `M43`. |
| P1 · a subscripted empty slot list | The property arm followed an object literal; the subscript arm answered `ordinary` for everything, so `({ slots: [] })['slots']` kept the ordinary label. | Mutant `M44`. |

**The depth cap had to be measured twice, and the first measurement was the interesting one.** The
cap was first set to 20,000 — comfortably above the deepest real tree — and the control asserting
that a deep walk throws FAILED. These walks exhaust the runtime's own stack at about 3,400 and
4,000 frames, so the cap never fired: the walk died with a `RangeError` while a caller watching
only for the cap's own error saw nothing. **A cap above the native limit is a cap that does not
exist.** It is 1,024 now — measured against a 20,633-line migration whose tree is 26 deep and a
pathological hundred-CTE nest that reaches 612 — and `isIncompleteWalk` treats a `RangeError` as
the same fact arriving by another route, for a machine whose stack is shallower than this one's.
The control that catches this is deliberately sized JUST above the cap and well below the native
limit, so it tests the cap rather than the runtime.

The P3 cluster was record parity: an "R5 has nine controls" that should have said eleven, two
mutant counts that had not kept up, a `DB_RESULT` placeholder, and a comment in the runtime test
still saying the guard reads four files when it reads five. All corrected — a record that
overstates its evidence is a finding, and these understated and overstated in turn.

### Review round 4 — the corrections themselves, and six more P1s

Round 4 was pointed at the FIXES rather than at the code they fixed: are they right, complete, and
honestly described? It found **six P1s, every one of them a defect introduced or left behind by a
previous round's correction.** That is the most useful thing this batch's reviews did, and it is
the reason a "corrections" round exists at all.

| Finding | What the correction missed |
|---|---|
| P1 · the last-writer rule was learned once, not everywhere | Round 2 taught `objectMember` that the LAST writer of a key wins. `classifyGuardSlots` had its own walk and returned on the FIRST match, so `({ slots: serRev.slots, slots: [] }).slots` kept the ordinary label while the guard was handed the empty list. There is one `literalMember` now, and both readers ask it. |
| P1 · a syntactic index is not a runtime index | `[...['x','y'], WRITING, 'SELECT 1'][2]` is `WRITING` at run time and `'SELECT 1'` to a reader that indexes the AST. A spread at or before the index makes the mapping undecidable. |
| P1 · the sentinel was produced but not consumed | The loop resolver received `UNREADABLE_NODE` and fell through to `null` — harmless — one line later, so a reassignable collection read as clean. And the `for…of` binding itself was never required to be `const`, though every other binding was. |
| P1 · the accessor check read only identifier names | `get 'sql'()` and `get ['sql']()` are the last writer of that key and walked straight past the round-2 fix. |
| P1 · the declaration index held only variables | A `class M { static sql = … }` shadowing an outer `const M` was walked past to the outer, harmless binding. Classes and function declarations are indexed now — and a function declaration's own name is scoped to where it is WRITTEN, not to its body, which is a second bug the first fix would have hidden. |
| P1 · `deriveIdTaking` unioned interfaces and aliases only | A `class Opts { id?: string }` merged with an `interface Opts { other?: number }` read as a shape carrying no id: the same last-declaration-wins defect the round-6 fix removed, one declaration KIND further out. |

**And four P2s about the evidence rather than the code**, which matter as much:

- The marker-collision rule refused `SELECT 'abc27holeatom'` — a hole-free statement that cannot be
  substituted into and so can lend an occurrence to nothing. A plainly decidable text answered as
  unreadable. It applies only where there is a hole now, with an acceptance twin.
- `objectMember` was over-conservative in the other direction: `{ ...{ sql: W }, sql: 'SELECT 1' }`
  is plainly `'SELECT 1'`, and a spread BEFORE the last explicit writer cannot overwrite it.
- The depth-cap control accepted `isIncompleteWalk`, so on a machine with a smaller stack it would
  pass via `RangeError` whether the cap existed or not — the exact state the cap was in when it was
  20,000. It demands `WalkTooDeep` specifically now, over an input just above the cap.
- `isIncompleteWalk` accepted EVERY `RangeError`, including `Invalid array length`. Narrowed to the
  message that means a stack ran out.
- The recursion's propagation of an inner body's `dynamic` findings was unsensed: deleting it left
  both the nested-body control and the one-level `EXECUTE` fixture green. A nested-`EXECUTE`
  control covers it now.

Three runbook claims were also wider than the code and are corrected in place rather than
defended: "every caller treats `UNREADABLE_NODE` as undecidable" (one did not), the B4 claim about
array subscripts, and "the enumeration is gone" — two enumerations remain, and both are now named
at their own site as things with no grammar to ask.

### A lesson the battery taught about the corrections themselves

Re-running the whole battery after round 2's fixes left **three survivors, and not one of them was
a remedy that had stopped working.** Two were sensors that the corrections themselves had BLINDED,
and that is worth writing down because it is the round-8 "a redundant gate hides its own mutation"
lesson arriving from the other direction:

- Round 2's fix asks the residual question — "does the ARGUMENT's own source name a writing
  routine" — in every branch rather than only when nothing resolved. That is strictly more
  reporting, and it is right. It also means the mutant that used to prove routines are read from
  the PARSE TREE (`FROM "public"."rebook_round_apply_command_as_actor"(1)` written inline) is now
  answered by the residual regex whether the tree is read or not. The remedy is fine; its sensor
  had become vacuous. A new mutant reaches the same invocation through a `const`, so the
  argument's own source is the bare name `QUOTED_CALL` and only the tree can see the call.
- The same widening made the hole-source mutant's predicate pass either way, because both the
  fixed and the broken reader end up reporting an unguarded invocation. Tightened to the one
  outcome that separates them: whether the hole was REPORTED as unreadable or quietly parsed as
  JavaScript.

**Widening a reader can blind a mutant that was discriminating yesterday.** The only thing that
catches it is re-running the whole battery after every widening, which is why the battery is run
whole and not incrementally.

The third survivor was a REPORTING defect in the harness, and it took TWO attempts to fix
properly — which is the more useful half of the story. `expect(unnoticed).toEqual([])` prints a
truncated array once it holds more than a couple of entries, so the name that reached the output
was whichever sorted first. Joining the names into one string did not fix it: the reporter
truncates a compared STRING at about forty characters, and a later full battery run again recorded
two "survivors" that were nothing of the kind — the census had noticed, the assertion had failed,
and the name of the remedy simply did not survive the ellipsis. Both killed cleanly when re-run
alone, which is how the false report was caught.

**An assertion MESSAGE is printed whole; a compared VALUE is not.** The names live in the message
now and the value is a count. A THIRD false survivor then appeared with the message printing
correctly, and the cause was the harness's own matching: it compared raw captured bytes, and a
reporter writing to a pipe wraps and colours differently than one writing to a terminal, so a
sensor name that spans a wrap is absent from a substring test while being plainly present on
screen. The match is made on ANSI-stripped, whitespace-collapsed text now.

A FOURTH class then appeared, and it is the one worth carrying forward. Every full battery run
produced a different pair of survivors, and each of them killed cleanly when re-run alone. These
sensors boot a real database; under the sustained load of a fifty-mutant run a sensor can time out
in its hook, and **a timeout is `failed` without the assertion ever having been evaluated** — which
the harness read as SURVIVED. The harness now separates the two: a run that did not reach its
assertion is retried once, and if it is inconclusive twice it is reported as INCONCLUSIVE rather
than as a survivor.

A mutation battery whose evidence depends on a reporter's truncation and wrapping rules, or on how
busy the machine was, is not evidence. **A battery that reports a survivor it does not have is
worse than one that reports nothing**, because the next person spends a round chasing a remedy
that was never broken — which is exactly what happened four times here before the harness was
fixed, and none of the four was a defect in the batch under review.

(The two findings above were the whole of that round's survivor list.)

### The evidence, counted

| Where | What |
|---|---|
| guard self-test corpus | **89 fixtures** (67 refusals / 22 acceptances, 43 of them analysed AS the factory) + 4 exemption fixtures, 148 assertions |
| lexer boundary cases | 17, unchanged — the lexer keeps its tripwire duties and its boundary is still stated rather than inferred |
| R5 import-surface controls | 11, two of them against the REAL runtime modules |
| oracle boundary controls | 4 — a write a hundred CTEs deep is still found; both walks THROW past the cap; a body inside a body is descended |
| census in-test mutants | **37 cases** — 34 written entries plus three generated empty-slot spellings. The 12 a prior round named, plus 25 this batch adds: three A2 hole positions, three A3 including the near-name control and the parse-tree-only one, one B4, four B5 spellings, the same-reason swap, three from review round 1, five from round 2 and five from round 3 |
| id-derivation mutants | 3, run over mutated copies while the factory stays byte-frozen |
| classifier probes | one per `@classifier`, with the list derived from the census module's own source |
| ephemeral mutation battery | **50**, all killed, anchors all applying |
| unreadable pins | 21 identities over 34 occurrences, each with a written rationale |

### Gates, on the final bytes

| Gate | Result |
|---|---|
| migration pin | `05e04451f944cabf` / 20,633 lines — double re-verified, byte-exact |
| `abc27SlotFixtures.ts` / `abc27TrainerAuthority.ts` | byte-exact throughout, including after every battery mutation |
| `npm run check:trainer-authority` | ✓ 19 fixed statements, 1 declared exemption, `libpg-query@18.1.4 (PostgreSQL grammar 180004)` |
| `npm run check:trainer-authority:selftest` | ✓ 148 assertions over 93 fixtures, incl. the real repository |
| CI workflow contract | ✓ |
| `eslint .` | ✓ 0 findings (exit 0 captured directly, not through a pipe) |
| typecheck (structured baseline, never bare `tsc`) | ✓ 82 pre-existing, baseline 82 — no new type errors |
| `npm run build` | ✓ |
| unit suite | ✓ 392 files / 3,977 tests |
| full db suite | one run green (163 files / 2,961 tests, ~16.5 min) on the round-1 bytes; the three-consecutive-run protocol is the terminal gate and is run on the FINAL bytes, so it is not claimed here yet |
| mutation battery | **50 mutants, 50 killed, 0 survived, 0 stale** — 47 reader, 3 runtime, partitioned per §5.3 |

**The battery's partition is the point, not the count.** Every reader mutant names a READER sensor
(a guard fixture by name, or a census in-test mutant by name) and every runtime mutant names a
RUNTIME sensor (the refusal matrix, the id-capability matrix, the byte-equality control). No
reader mutant is "proved" by a runtime control or the reverse.

**A SECOND gap was found the same way, and it is the batch's own failure mode wearing a new hat.**
`auditFactoryText` refused an unparseable factory literal only when the LEXER had counted a write
in it — and "the lexer saw no write" is a claim about the lexer, not about the statement. A text
that lexes cleanly with no write verb while the canonical grammar cannot read it at all was
audited by neither detector and refused by neither. Measured before widening: the factory holds 56
plain literals, 19 of which name the guarded relation, and **all 19 parse** — so naming the
relation is now enough to demand a readable parse, and nothing legitimate pays. Two fixtures and
two battery mutants: `M24` reverts the widening and is killed by the unparseable-literal fixture;
`M25` makes the refusal unconditional and is killed by the readable-SELECT acceptance, so what
refuses is unreadability rather than naming the relation.

**One latent defect was found by re-reading this batch's own code, and is recorded because a
reviewer did not find it and nothing else would have.** The occurrence search is a SUBSTRING
search — an atom is often only part of the value the parser produced, as in `'\x${hex}'::bytea` —
and the atoms were spelled `stem0`, `stem1`, … `stem11`, where the eleventh contains the second.
In a text with eleven or more holes, a hole the parser had ERASED would find the longer-numbered
hole's occurrence and be read as inert: the certifying direction, and invisible today because no
text in this file carries eleven holes. Atoms now carry a terminator, the property is asserted
directly on a synthetic twelve-hole text, and battery mutant `M23` reverts the terminator and is
killed by that assertion by name. The pin table is unchanged by the fix — 16 identities, 29
occurrences, before and after — which is the evidence that it closed a latent hole rather than
moved a live verdict.

**Three mutants initially survived and every one was the MUTANT being wrong, not the remedy** —
recorded because that is the same lesson the round-5 remediation wrote down:

- `M7` reverted the unreadable-body refusal by short-circuiting a branch whose `descended.queries`
  the next line then dereferenced: it CRASHED rather than reverting, and a crash is not a
  reversion. Rewritten to make the refusal unreachable while the code still runs.
- `M8` reverted the projection-arity rule and nothing failed — the fixture aimed at it
  (`SELECT * FROM …`) is refused by the VALUE rule as well, so the arity rule had no sensor of its
  own. Rather than leave an unsensed gate (the round-8 lesson: a redundant gate hides its own
  mutation), the fixture was re-aimed at a shape only arity catches — three projected values for
  two columns — and two more were added, one for the VALUES arm and one that keeps the `SELECT *`
  refusal attributed to the value rule.
- `M13`/`M15`/`M3b` all failed their sensor's TEST while a different assertion's message reached
  the output first. Two fixes: the census controls were split into three `it()` blocks so a
  mutation to the reader cannot make the mutant battery unreachable, and the battery loop now
  COLLECTS every unnoticed mutant instead of aborting at the first — so one run names every remedy
  that lost its sensor. `M3b`'s stub was also made faithful: returning zero statements was caught
  by the one-statement rule rather than by the audit, so it now returns a benign one-statement
  parse, which is the permissive stub the envelope actually names.

### The parser as a dependency

`libpg-query@18.1.4`, **exact-pinned** as a devDependency — not a range, because a grammar that
moves under the gate is a gate that changed silently. Pure WASM (`main: ./wasm/index.cjs`), one
transitive dependency (`@pgsql/types`, types only), no postinstall script, and no network at load:
it reads its `.wasm` off disk. `loadModule()` is async, so the guard script does it once at module
scope with a top-level await, and the two suites do it in the tests that need it.

`package.json` +1 line, `package-lock.json` +18. A clean checkout was proved rather than assumed:
`npm ci --ignore-scripts` in an empty directory holding only those two files installs 796 packages
and resolves `libpg-query@18.1.4`.

### One recorded load-sensitive control fired, and it is finally characterised

`the psql resolver spends one budget across all candidates, and fails loudly when none answers`
(realpg ~13259) failed ONCE during this batch, immediately after a fifty-mutant battery had been
hammering the machine, and passed on the next two runs. It is one of the three load-sensitive
child-process controls the envelope names as recorded rather than repaired, and it touches nothing
this batch changed — it is a pure function under a stopwatch, with no database and no reader in it.

**Its message is captured here, which the prior record did not have:**

```
AssertionError: expected { invoked: false, …(17) } to deeply equal { invoked: true, …(17) }
```

That is the diagnostic half worth keeping. `invoked` is `existsSync(marker)`, and the marker is
written by the fake `psql` scripts the control spawns — so the failure is not the resolver spending
its budget wrongly, it is the fake **never having been executed at all** inside the 1,500 ms
budget. Under enough load, `spawnSync` of a freshly-written shell script does not reach the
script's first `echo` before the budget expires, and the control then reads a true statement about
the machine as a false one about the resolver. That is a characterisation, not a repair: nothing is
widened, no timeout is raised, and the control is left exactly as it was.

**And a second interruption that was NOT a defect at all**, recorded so it is not re-diagnosed
later: one realpg run failed to collect entirely, with `Unknown Error: undefined` and a teardown
complaint. An embedded PostgreSQL abandoned by an earlier battery run still held port 54397, so the
suite could not boot its own server. That residue is this batch's tooling, not the suite's — the
battery runs the realpg file dozens of times and a killed run can leave a server behind. Cleared,
and the run was green immediately afterwards.

### Barrier 10b, still separated

`barrier 10b: the lifecycle writer consumes BEFORE its first product row lock` (realpg ~19077)
failed once in nine runs at the previous stop. It runs before anything this batch touches, its
region is byte-untouched here, and it is **not repaired or hidden in this batch**. Its
characterisation remains the separate follow-up item the envelope named: run it in isolation under
load with full output persisted until captured once, then triage on its own record.

## THE ROUND-5 STOP — the review budget is spent and four P1s are open

**STATUS: `STOPPED_FOR_OWNER — 4 OPEN P1, NO POST-FINAL-ROUND EDITS MADE`.**

Five fresh review rounds were budgeted and five were spent. The fifth returned **four P1s**, and
the envelope's discipline is explicit about what happens next: *any open P1 after the final round
is an owner stop, and there are no post-final-round edits.* That rule is the reason this envelope
exists — the two previous stops followed it, and a batch that fixes findings after its last review
is a batch whose last review no longer describes it.

So nothing below is fixed. Each finding was **reproduced read-only** before being written down,
because a stop record that hands the owner an invalid finding is worse than no record at all.

### The four, with the input that produces them

**P1-1 · an unqualified `unnest` is certified as the built-in, and cannot be.**
`scripts/check-abc27-trainer-source-authority.mjs` accepts the unqualified spelling as PostgreSQL's
built-in `unnest`. An unqualified function name resolves through `search_path`, so a schema ahead of
`pg_catalog` that defines a competing `unnest(uuid[])` supplies the rows instead — and the trainer
the audit calls "parameter-bound" is then whatever that function returns. Round 1 closed the
SCHEMA-QUALIFIED lookalike (`evil.unnest($1)`); this is the same hole through the spelling the
factory actually uses.

**This one cannot be closed inside this envelope, and that is the point of stopping.** The frozen
factory writes `FROM unnest($1::uuid[])` twice. Refusing the unqualified form turns the guard red
on the real tree; accepting it is the certification above. The three ways out are all owner calls:
change two byte-frozen statements to `pg_catalog.unnest`, add a RUNTIME control that pins
`search_path` where those statements run, or narrow the stated claim to exclude it. The first two
are material changes to a frozen runtime module; the third is a decision about what this gate
promises.

**P1-2 · a hole in an ordinary expression position can BE a call.** Reproduced:

    async function send(sqlExpr: string) { await c.query(`SELECT ${sqlExpr}`, []); }
    send('public.rebook_round_apply_command_as_actor()');

The census returns `{ paired: [], unguarded: [], unreadable: [] }`. The substituted atom lands as a
`ColumnRef`, which `occurrencePosition` calls inert. The sentinel protocol's stated assumption is
that it does not model a hole whose value BREAKS OUT of its construct — and this value breaks out
of nothing: it is a well-formed expression that happens to be an invocation. The assumption as
written does not cover the case, so the protocol answers in the certifying direction.

**P1-3 · a destructuring default in a `for…of` tuple.** Reproduced, census empty:

    for (const [, sql = CALL.rebook_round_apply_command_as_actor] of [['case', undefined]]) {
      await c.query(sql, []);
    }

JavaScript selects the default. The resolver treats an `undefined` arm as a decided non-text — a
correction made in round 4 for `[['shipped', null], …]` — and never looks at the binding's own
initializer, which is where the writing text is.

**P1-4 · a constructor parameter property is a class member.** Reproduced:
`deriveIdTaking` returns `{ idTaking: [], unreadable: [] }` for

    export class Opts { constructor(public id?: string) {} }
    export async function insertProbe(client: unknown, opts: Opts) { return opts; }

`public id` declares an instance property; the class walk reads `members[*].name`, the constructor
has no name, and its parameters are never visited. The shape is decided as carrying no id rather
than reported as unreadable — the exact shape of the round-5 omission this control exists to close.

### The P2 and P3 findings, also open

- **Four pinned identities are over-refused** (`01b4e82ec671bc04`, `d20b3f57e4a84ac8`,
  `d21549c177209028`, `95ad9610dc604170` — eight occurrences). The first three interpolate from
  literal `for…of` loops the resolver could follow, and the fourth is hole-free text the PG18
  grammar refuses, which is decided-no rather than unknowable. Four rounds of fail-closed
  corrections have accumulated into a reader that pins things it could decide, and that is worth
  correcting deliberately rather than in a hurry.
- **The record's own arithmetic has drifted** and is corrected HERE rather than edited above,
  because editing the reviewed prose after the final round is the thing the rule forbids. The
  numbers as they stand on these bytes: **59 battery mutants** (not 50), **43 census mutant cases**
  — 40 written plus three generated (not 37), **4** id-derivation mutants (not 3), and the section
  above that says "four P2 evidence findings" lists five.
- **Stale prose remains in two code comments**: `check-abc27-trainer-source-authority.mjs:1746`
  still says the guard reads four named files (it reads five), and three comments in the realpg
  census region still describe sixteen pins (the live census pins 21 identities over 34
  occurrences). Both are wrong in the direction of understating the guard, and neither is edited.
- One claim in this record is still wider than the code: it says both remaining enumerations fail
  closed, and the routine-name-field enumeration does not — a field nobody has named reads as
  inert, which the oracle's own comment says plainly.

### What IS established on these bytes

| Gate | Result |
|---|---|
| migration pin | `05e04451f944cabf` / 20,633 lines, re-verified |
| `abc27SlotFixtures.ts` / `abc27TrainerAuthority.ts` | byte-exact against the preserved bytes, after every battery mutation |
| `check:trainer-authority` | ✓ 19 fixed statements, 1 declared exemption, `libpg-query@18.1.4 (grammar 180004)` |
| `check:trainer-authority:selftest` | ✓ 149 assertions over 93 fixtures |
| `eslint .` · typecheck · build · CI contract | ✓ 0 · ✓ 82/82 · ✓ · ✓ |
| unit suite | ✓ 392 files / 3,977 tests |
| **full db suite, on THESE bytes** | ✓ **163 files / 2,961 tests, 0 failures**, 935 s |
| mutation battery | ✓ **59 mutants, 59 killed, 0 survived, 0 stale** |

The reviewer independently confirmed the live census still produces the recorded seven paired
paths, zero unguarded calls, and 21 identities over 34 unreadable occurrences.

**The three-consecutive-run repeatability protocol was deliberately NOT run.** Its terms are three
green runs on the FINAL bytes, and these bytes are not final in that sense: they carry four open
P1s and will move if the owner authorises any fix — most certainly for P1-1, which cannot be
closed without touching a byte-frozen module or adding a runtime control. One full run is recorded
above as evidence of the state as it stands; the protocol belongs after the owner's decision, not
before it.

The four open P1s share one shape with the seventeen already fixed — a reader answering a question
it cannot decide, in the direction that certifies — which is the honest reading of this batch: the
architecture removed the failure mode from the SQL-grammar questions, where a canonical parser now
answers, and did not remove it from the JavaScript-resolution questions, where there is no oracle
to ask and every answer is an enumeration. That is a true statement about what was bought and what was
not, and it belongs in the owner's decision rather than in another round of patches.

**The owner's decisions**: whether P1-1 is closed by editing two byte-frozen statements, by a new
runtime control, or by narrowing the claim; and whether P1-2 through P1-4 and the P2/P3 items are
authorised as a further batch under a fresh review budget.

---

## THE CLOSED-CATALOGUE BATCH — the JavaScript reader is deleted, not extended

> **RECORD-AUTHORITY NOTICE (2026-09-04).** From this heading to the end of the
> runtime-containment section below, every NUMBER is a historical snapshot of the round it was
> written in — fixture, assertion, control, test and mutant counts, and the figures in every
> "evidence" and "gates" table. None of them is current authority, and none of them is
> machine-checked any more: the test that derived figures from this prose is retired, and a
> machine-derived cardinality now lives only in an executable set-equality assertion or in a
> gate's own runtime output. Likewise, every description in these sections of a caller-owned
> `Buffer` at the fingerprint boundary — the intrinsic-`toString` renderer, the byte-snapshot
> copy, the `ArrayBuffer.isView`/tag/`isBuffer` gate and the mutants written against them —
> describes a design that has since been RETIRED; the boundary is a primitive string of
> canonical hex. The current invariants, commands and pass criteria are stated once, in
> `## CURRENT — the canonical hex boundary and record authority` at the end of this document,
> and nothing in the sections between is edited to match them: this is a journal, and it is
> left as written.

**STATUS: implemented, and every gate in the table below measured green on the final bytes EXCEPT
the terminal three-consecutive-run database protocol, which by construction runs after this
document is final and whose result is deliberately NOT recorded here — see "why no run table lives
here". "Every gate is green" would be a claim about a run this document cannot contain.
Local only: nothing is committed, pushed, merged, deployed or applied, and no migration is
touched.**

The round-5 stop above ended with four open P1s that shared one shape: *a JavaScript reader
answering a question it cannot decide, in the direction that certifies.* The previous batch had
already removed that failure mode from every SQL-grammar question — PostgreSQL's own parser answers
those now — and could not remove it from the JavaScript-resolution questions, because there is no
oracle for JavaScript dataflow. Every answer there is an enumeration, and four consecutive rounds
each found the neighbouring enumeration hole.

The owner's decision was architectural rather than another patch round:

- **P1-1 is closed by EDIT.** All THREE guarded `unnest` calls are qualified as
  `pg_catalog.unnest` — the two in the slot factory (`abc27SlotFixtures.ts:215`, `:234`) and, by
  owner amendment, the one in `ensureProfiles` (`abc27TrainerAuthority.ts:238`) that the stop
  record had recorded as an owner-visible note. A `search_path` pin and a narrowed claim were both
  REJECTED.
- **The remaining work removes open-ended JavaScript source resolution from the certifying path
  entirely**: the general JS text resolver is deleted rather than extended.

### What replaced the census

`src/test/abc27ApplyCatalogue.ts` is the apply-invocation analogue of the slot factory, one
deliberate step stricter. Every statement that invokes `rebook_round_apply_normalized_core` or
`rebook_round_apply_command_as_actor` is a module-private constant there, and each of the seven
writing call paths the suite had is now a typed entrypoint of exactly four statements — the SEAL
that reads the caller's argument record once, the ownership check, the target claim, and one
`client.query`. There is no branch a guard can sit
outside of, no second query, and no path from an argument to WHICH statement is sent.

Behavioural preservation was the rule, not an aspiration: **every rendered text WAS byte-identical
to what the suite sent before the conversion**, measured directly at the time.

**That is a statement about the conversion, and it stopped being true of the CURRENT bytes.** A
later round found the two array-input renderers losing values their validator accepts, and the fix
— quoting each element — deliberately changes every multidimensional and zero-based rendered text.
The conversion preserved them; a subsequent correction did not, on purpose, and saying so is the
point of keeping the sentence rather than deleting it. A harness rendered all seven
statements plus all thirteen non-default array presentations the replay-shape controls submit
(multidimensional, zero-based, NULL-member, ragged, empty) through the catalogue and compared them
character for character against the pre-conversion expressions; it was then shown to discriminate
by corrupting one expected byte. No database outcome, digest pin or product assertion moved.

| Pre-conversion call path | Catalogue entrypoint |
|---|---|
| `applyNormalized` (the shared driver) | `applyNormalizedCore` |
| the receipt-privacy `as_actor` wrapper | `applyCommandAsActorReceiptPrivacy` |
| the wrapper refusal matrix's `apply` arm | `applyCommandAsActorRefusalProbe` |
| the replay-SHAPE driver (11 shapes, 5 mismatches) | `applyNormalizedCoreShaped` |
| the extend shape control | `applyNormalizedCoreShapedExtend` |
| the revoked-manager barrier | `applyCommandAsActorRenderedBarrier` |
| the operator-reachability call | `applyCommandAsActorReachability` |

**Four of the seven carry holes, and a hole here is not an interpolation.** `node-postgres` cannot
express a non-one-based array from a JavaScript value, and that SHAPE is exactly what the
replay-shape controls are about.

**This record used to say "multidimensional or non-one-based", and two review rounds measured it
and found BOTH halves wrong.** `pg`'s serializer recurses: `prepareValue([['a'],['b']])` returns
`{{"a"},{"b"}}` and a NULL member returns `{"a",NULL}`, so multidimensional is expressible. And a
bound parameter is not confined to a JavaScript `Array` — `prepareValue('[0:1]={a,b}')` returns
the string untouched, so a non-one-based array CAN be bound, as text.

**The true statement is narrower than either version**: a native JavaScript `Array` does not
serialize a lower bound, because the bound is not part of the value. Rendering is what these
statements use to get one; binding a hand-written text would be the alternative. **And "four
cannot be parameterised" was one too many**: three carry the shapes, while the fourth — the
refusal probe — renders a single academy UUID and could have been a bound parameter. It is a
template because it was written beside the other three. Each hole is a direct call of one of three
closed renderers over VALIDATED scalars — a canonical UUID, an ISO date, a letters-and-spaces
label, hex taken from a `Buffer` by construction. None of those can contain a quote, a bracket, a
comma or a paren, so no rendered value can change what the statement IS; a value that fails its
shape is a THROW rather than a quoted rendering, because a validator that sanitises is a validator
to defeat.

**The raw texts are not exported.** The factory publishes `SLOT_STATEMENTS` so a control can
compare what it sent against what it holds; this module publishes `APPLY_STATEMENT_DIGESTS`
instead — the sha256 of each statement as it renders it from its own canonical example. A digest
proves the same property and cannot be invoked.

### The four P1s, each with the one control that proves it

| Finding | Remediation | The control |
|---|---|---|
| **P1-1** an unqualified `unnest` certified as the built-in | All three guarded statements write `pg_catalog.unnest`; the checker accepts ONLY that spelling as the built-in, and a new rule refuses a bare `unnest` in every guarded SQL surface (factory, authority, catalogue), fail-closed on both sides of the parse and through a PL/pgSQL body | `g2-unqualified-unnest` — a factory statement whose trainer is a well-behaved bound parameter and whose `unnest` alias authorises nothing, so ONLY the qualification rule can refuse it (verified by disarming that rule alone: the fixture then produces zero violations). Battery `M01`/`M02` revert each qualification on the real tree |
| **P1-2** a hole in an expression position can BE a call | The certifying census is deleted; the invocation text must now spell a writing routine in some decoded token, which **G4** refuses unless pinned | The exact reproduction as the named fixture `g4-invocation-through-a-hole`, refused by the STRING half of G4 and by nothing else |
| **P1-3** a `for…of` destructuring default selects a stored call text | The stored call map's apply entry moved into the catalogue. The default's spelling is a property-access identifier — the `read` category, which has **no pin at all**, because the thing being read cannot exist outside the catalogue | `g4-stored-call-read-through-a-destructuring-default`, refused by the IDENTIFIER half and by nothing else |
| **P1-4** a constructor parameter property is invisible to `deriveIdTaking` | `deriveIdTaking` and its four derivation mutants are DELETED. The completeness proof is a runtime **foreign-id sweep**: every entrypoint on the pinned export list is driven with a foreign id smuggled into its option shape (or, where it has none, as an extra argument), and the id must reach no sent text and no sent value — or the authority must refuse before anything is sent | The sweep itself, shown to discriminate: a factory mutation that reads `(s as any).id` into `insertSlotSeries`'s bound values is caught by the sweep and by nothing else (the ordinary matrix refuses on the foreign TRAINER first — the exact round-5 omission shape) |
| **Four over-refused pins** (`01b4e82e…`, `d20b3f57…`, `d21549c1…`, `95ad9610…`) | Discharged by deletion. The pin table of certifying non-decisions no longer exists; the replacing question — "does this token spell a writing routine" — decides all four instantly as *no* | None of the four texts appears in the mention inventory, and the inventory is checked in BOTH directions on the real tree |

### The checker: what is added, what is deleted

**G3 — the catalogue audit.** Every statement constant is a plain literal or a template whose
every hole is a direct call of a named private renderer (one syntactic level; nothing to resolve).
With the holes filled by the CHECKER'S OWN canonical examples — not the module's, which would make
the audit a function of the thing it audits — each is parsed and must be exactly one closed
`SELECT … FROM public.<writing routine>(closed args)`: no `WHERE`, `WITH`, set operation, second
`FROM` entry, `ROWS FROM`, `WITH ORDINALITY`, column definition list, lock, table reference or
write anywhere in the tree, and no routine invoked beside its own except
3 pinned value built-ins — compared by **full dotted name**, because reading only the last element is the
`evil.unnest` hole wearing a new hat. Entrypoint structure, the one-entry no-slots entitlement, the
renderers' privacy, and the export surface are all pinned.

**G4 — writing-routine spelling containment.** Over every `src/test/abc27*` file except the
catalogue — the guard's program AND the scope-drift set, so a sibling test cannot re-open the
surface — any decoded string token, template part or identifier whose text names a writing routine
is refused unless its content identity is in the pinned inventory. Comments are excluded: a
JavaScript comment cannot reach a server, and the names appear in dozens of them explaining exactly
this design. Matching folds case and demands identifier BOUNDARIES, so the shipped near-name
`rebook_round_apply_lifecycle_command_as_actor` and any future longer name are different routines
and do not ride the refusal — both stated as acceptance fixtures rather than left to be discovered.

**The mention inventory: 12 identities over exactly 26 occurrences**, each identity carrying its
own one-line rationale, its own category and its own count, and each a decided, NON-INVOKING
mention. **The count is pinned, not descriptive** — this paragraph used to say the opposite. So is
the category: a pin decides a text OF A GIVEN KIND, and the kind is compared with the kind the
token is actually seen in rather than being a note beside it.

| Class | Identities | What they are |
|---|---|---|
| catalog probes | `d088ed2e7e02fcbe`, `731d1255376ed092` | `has_function_privilege(<role>, p.oid, 'EXECUTE')` over a `proname IN (…)` list — the routines are catalog ROWS to be measured |
| bare names in expectation lists and inventories | `823468e8c6b7f7a7`, `99ed2366d53d0afe` | a name in a JavaScript array is inert AS WRITTEN. It used to say such a name "reaches no server at all", which is not something this can know: the array element can be iterated, and the count is what keeps a SECOND spelling from inheriting the decision made about this one |
| GRANT text | `ae676029a4e5ebec` | the deliberate improper grant control, planted and rolled back so the reachability probe is proved able to see one |
| installed signatures | `ebbc80cb24f67303`, `a3b21fed2adf52f9` | the sorted signature inventory the Stage-0 surface pin is taken over |
| runbook-parity fragments | `3a43178c3be886db`, `b2c0a477afd68058` | the transfer-manifest entry and row, compared as text against a file on disk |
| splicing anchors | `b66f3c7273dcb54f`, `2183c9a88ae0efc8` | `String.prototype.indexOf` arguments that bracket the apply core's own body in the migration text |
| expectation-map keys | `1b2a97ad431f22cf` | a KEY declares an entry; OBTAINING one under that name is the `read` category, which has no pin |

**The oracle shrank.** `stringOccurrences` and `occurrencePosition` are deleted with their only
consumer, and with them the one enumeration in that file that genuinely failed OPEN — a
routine-name FIELD nobody had listed read as inert. It is deleted rather than extended, which is
the point: no field enumeration carries certification weight anywhere any more.

### Runtime evidence

`src/test/abc27ApplyCatalogue.runtime.test.ts` (new, unit project, recording client, outside the
guard's program like the factory's runtime test, and spelling neither routine name): every
entrypoint is driven with the module's own canonical example and the sha256 of what it sent must be
that entrypoint's own digest — asked in BOTH directions, so nothing is sent that is not in the
inventory and no inventory entry goes unsent. Then, per entrypoint: a foreign SOURCE slot and a
foreign TARGET slot each refused with `sent === []`; the one no-slot entitlement accepted and shown
to claim nothing; ten hostile renderer inputs (a closing quote, a quote-and-second-member, a comma
splice, both parens, a set operation, a closing bracket, a bare word, the empty string, a number)
each refused with nothing sent — all ten are strings, the last being `'1'`, and a non-string
element is refused by the seal rather than by a renderer; date and label shapes held to their own
validators; three unrenderable array presentations refused; and a bytea literal refused from
anything but a `Buffer`.

`abc27SlotFixtures.runtime.test.ts` keeps its refusal matrix, its id-capability matrix and its
byte-equality control, loses `deriveIdTaking` and its four derivation mutants, and gains the
foreign-id sweep — which is TOTAL over the pinned export list rather than over a derived subset,
so "the derivation went quiet" is not a failure mode it has.

### Deletions, in full

- `src/test/abc27ApplyCensus.ts` — the whole module (pre-edit sha256
  `66001bb42f2b86ff2340f336a47e77044e813ab0edf1f46e938d91877309c388`, recorded here because the
  file was untracked and the deletion is therefore only auditable against the preserved manifest).
- realpg: the three census tests, the classifier-probe/prefix-free test, the census import block,
  `enteringApplyWrite`, `APPLY_WRITE_PATHS`, and the apply-side `assertSourceSlotsOwned` uses at
  every converted site — **718 lines**. `previewNormalized` is NOT one of them: it reads, so it
  keeps its own source-slot check.
- runtime test: `deriveIdTaking` and its four derivation mutants.
- checker: every census reference; oracle: the sentinel-protocol support and its boundary control.

### RECORD CORRECTIONS

The round-5 stop recorded four documentation defects it was forbidden to edit. All four are
corrected here rather than by rewriting the reviewed prose above.

1. **The itemized arithmetic.** The numbers as they stood on the round-5 bytes were **59 battery
   mutants** (the "The evidence, counted" table above says 50), **43 census mutant cases** — 40
   written plus three generated (the table says 37), **4** id-derivation mutants (the table says 3),
   and the section that says "four P2 evidence findings" lists five. Those corrections stand as
   the record of THOSE bytes.
2. **Those numbers are now RETIRED with their subject.** The census, its 43 in-test mutant cases,
   its classifier probes, its 21 unreadable identities over 34 occurrences, and the four id-
   derivation mutants no longer exist. They are not superseded by a larger number; the question
   they answered was deleted.
3. **The stale checker comment is fixed.** `check-abc27-trainer-source-authority.mjs` said the
   guard "reads four named files" while its program held five; it now names all five (authority,
   factory, catalogue, suite, guard unit suite) and says so in both places, with a sentence
   recording that the prose was wrong for a whole round because nothing else notices that class of
   drift.
4. **The three realpg "sixteen pins" comments are deleted with their region** — they lived in the
   census tests.
5. **The fail-closed over-claim is corrected.** The record said both remaining enumerations fail
   closed. The routine-name-field enumeration in the oracle did NOT — a field nobody had named read
   as inert, which the function's own comment said plainly. That enumeration is now DELETED rather
   than restated, so the claim is true because the thing that made it false is gone.

### Expected evidence deltas, and the measured ones

| Delta stated up front | Measured |
|---|---|
| realpg loses four tests | four census tests deleted; realpg −718 lines |
| unit project gains one file | `abc27ApplyCatalogue.runtime.test.ts`, 16 tests |
| the guard corpus grows by the G3/G4/`unnest` fixtures | 93 → 107 fixtures; 149 → 197 assertions |
| `EXPECTED_FACTORY_STATEMENTS` stays 19 | 19 |
| the grammar line is still printed on every guard run | `libpg-query@18.1.4 (PostgreSQL grammar 180004)` |


### The review rounds, and what each one changed

All five budgeted `gpt-5.6-sol` `ultra` read-only rounds have been spent. Rounds 3, 4 and 5 ran in fresh threads because the MCP session was lost twice — to a connection restart and to an idle timeout — which costs a thread, not a round; the round count is what the budget is over, and round 2's verdict was recovered from the session transcript rather than assumed. Every finding
below was reproduced before being acted on, and every fix carries a control that fails without it.

**Round 1 — the catalogue, its renderers, and the runtime evidence.** Six P1s, two P2s, three P3s,
all valid, all fixed:

- `RenderedArray.type` was interpolated into the cast without validation. A caller arriving through
  `as never` — which is how every smuggling fixture gets there — could supply
  `type: "uuid[] || ARRAY['<a foreign slot>'::uuid]::uuid"` with an EMPTY value list, validating
  nothing and rendering a second array expression into the statement. Both discriminants are now
  held to closed sets.
- **The check and the send were two reads.** `assertSlotsNotForeign(a.slots …)` and
  `client.query(…, [… a.slots …])` each evaluated the property, so an accessor answering `[]` first
  and a foreign slot second satisfied one and fed the other. This is the getter shape the whole
  batch exists to be immune to, one layer further in than where it had been closed.
- **A non-string element was skipped by the check and serialized by the driver.**
  `assertSlotsNotForeign` ignores a non-string on purpose (fixtures pass a deliberate `null`), while
  `node-postgres` calls a value's own `toPostgres()`. `[{ toPostgres: () => <a foreign slot> }]` was
  checked as nothing and sent as that slot — measured against the installed driver.
- The runtime drive compared digests but never bound values, so swapping two parameters stayed
  green. It now asserts the values too.
- The foreign-id sweep matched one exact lower-case string, so a case-changed or nested form walked
  past it; and it stopped at the writing entrypoints, leaving the one pure reader unpinned as such.
  It now compares canonically and covers the whole function-export surface.
- The foreign matrices drove the plain and the rendered list from ONE array, so removing either
  half of the guard still refused. They are driven independently.

The SECOND and THIRD share one answer — the first does not, and saying otherwise was itself a
finding. Every entrypoint now OPENS BY SEALING ITS INPUT — `const <local> = sealed(<its argument
record>)`, which is the invariant the guard actually enforces; the local is named `a` in four of
them and `s` in the three that take a spec, and the guard refuses any name that collides with a
module binding. The seal is a single read of the caller's
record that also refuses a non-string identity element and any function value, taken with an index
loop rather than the array's own `map`, and G3 refuses an entrypoint that reads its parameter again
afterwards. A hostile `RenderedArray.type` survives sealing untouched — it is an ordinary string —
and is refused by the renderer's own closed-set check instead.

**Round 2 — the checker and the corpus.** Cut off by a connection loss before it delivered a
consolidated list; it is counted as spent, and the two observations it did deliver were reproduced
and fixed: a composed text whose identity deferred to a PINNED operand was never reported (the bare
routine name is a pinned inventory element, so `'SELECT public.' + <that name> + '()'` had an
operand that "already spelled it"), and the composition fixtures covered `+` but neither
`[…].join(…)` nor `.concat(…)`, which are separately implemented.

**Round 3 — the composed whole and the record.** Its largest findings were about the RECORD, which
is the half a reviewer is best placed to judge:

- Two real containment gaps, both the same shape and both closed the same way. G3 records the
  statement and the renderers BY IDENTIFIER TEXT and then looks them up among the module's
  constants — so a parameter of that name shadows the constant, and the audit reads one statement
  while the runtime sends another. Rather than resolve the binding (resolution is the class of
  question this design removed), shadowing is made unconstructible: an entrypoint takes exactly two
  plain parameters and declares exactly one local, and a rendered statement is an arrow of exactly
  one plain parameter.
- **A rule with no control.** The "is this statement exported" branch could be deleted with nothing
  noticing, because exporting a statement necessarily breaks the export-surface EQUALITY already.
  A redundant gate hides its own mutation — the lesson two batches back — so the branch is deleted
  and a comment stands where it was.
- **The boundary class was ASCII.** `rebook_round_apply_normalized_coreé`, `…coreλ` and `…core中`
  are ordinary identifiers naming no routine of ours, and all three were refused as if they named
  the guarded one. The class is the Unicode one now, with an acceptance fixture.
- **Nine stale numbers and one contradiction in this record**, every one corrected above: the
  entrypoint statement count, the catalogue runtime test count, the fixture and assertion counts,
  the G3 and G4 control counts, the sweep's membership, the hostile-input description, and the
  composition-shape count. The status line claimed all gates green while the gate table marked the
  database protocol pending; the two now say the same thing.
- The ownership tests took their foreign slot from whichever test ran first, so running one alone
  stopped testing a foreign identity at all. It is minted in a `beforeAll` under the BOOTSTRAP
  identity — which no test can ever be — so every case sees it as foreign in any order, and a
  control asserts exactly that.

**Round 4 — verification of the round-3 corrections.** It found a defect the corrections had
introduced and several the earlier rounds had not reached:

- **The unit suite was RED.** Adding fixtures had moved the corpus split while the assertion that
  pins it still named the old numbers, so `check:trainer-authority:selftest`'s fixture-count case
  failed before it assessed anything else — while this record said every gate was green. That is
  the plainest kind of record defect and it is why "count it yourself" is the first thing each
  round is asked to do.
- **Two containment gaps of one shape.** G3 records the statement and the renderers BY IDENTIFIER
  TEXT and then looks them up among the module's bindings, so a name declared inside the
  entrypoint means something else at run time: `const APPLY_NORMALIZED_CORE = sealed(args)` sends
  the sealed RECORD while the audit reads the module's statement, and a rendered arrow whose sole
  parameter is named `renderArray` shadows the renderer the checker substitutes for. Arity was not
  the property; not colliding with a module binding is, and optional parameters are refused too.
- **Deleting the statement-export check as "redundant" was wrong.** The export-surface equality
  pins NAMES, not what those names hold: free the pinned `APPLY_STATEMENT_DIGESTS` name, give it
  to a statement, and export it — the exported set is still exactly the pinned one while a raw
  text has left the module. Restored, with a case of its own that the equality cannot answer.
- **Five structural rules had no case that isolated them** (each was rejected earlier by arity or
  by the export equality), and two sealing rules had none at all. Six G3 cases and three runtime
  tests were added so each has one.
- **Sealing called the caller's code.** `sealedValue` used the value's own `map`, which an array
  may own — so it could hand back an object carrying `toPostgres()`, which the ownership check
  skips as a non-string and the driver then serializes. It reads `length` and each index instead.
- **The unicode-escape decoder was three global passes, not one scan.** `U&"a!!005Fb" UESCAPE '!'`
  is a DOUBLED escape followed by ordinary characters — the identifier `a!005Fb` — and the
  four-digit pass fired inside it and produced `a!_b`, an identifier the text never contained.
  Rewritten as a single left-to-right scan, with four cases of its own.
- **The identifier-boundary class was ASCII, then BMP-only.** `…coreé`, `…coreλ`, `…core中`,
  `…core𐐀` and `core` + a combining mark are ordinary identifiers naming no routine of ours, and
  each was refused as if it named the guarded one. The class is Unicode and the reads are by code
  POINT; the acceptance fixture carries all five.
- The sibling slot-fixture suite still took its cross-test identity from whichever test ran first.
  Both suites now mint it in a `beforeAll` under the bootstrap identity.

**Round 5 — the record against the code, counted.** Its P1s were all record defects, which is the
half a reviewer is best placed to judge and the half that had drifted twice already: a "two shapes"
that named three, a "19 fixed factory statements" that conflated the nineteen guarded WRITES with
the twenty statement constants, and a "seven stale numbers" that listed nine. It also made one
correction to a claim rather than a count, and it is the more useful of the two: **the mention
inventory pins 12 IDENTITIES, and the "26 occurrences" beside them is a description, not a pin** —
a duplicate occurrence can disappear without a failure. That is the deliberate design (the unit of
justification is the SHAPE, exactly as the retired census's content pins had it), but the record
had been stating it as though both numbers were held. Three further stale comments in the source
went with it.

Round 5 independently confirmed the figures **as they stood at round 5**: seven statements, seven
entrypoints of four statements each, four of them carrying holes through three renderers, five
files in the guard's program, 107 fixtures (103 verdict — 76 refusals, 27 acceptances, 44 factory —
plus 4 exemption), 196 self-test assertions, 27 G3 controls, 13 G4 fixtures, 21 lexer cases, 4
oracle cases, 12 import-surface controls, 15 scope-drift controls, 12 mention identities, 16
catalogue runtime tests, 19 guarded factory write statements, 20,633 migration lines and the
migration digest.

**SEVERAL OF THOSE FIGURES HAVE SINCE MOVED, AND THE LIST ABOVE IS A ROUND-5 SNAPSHOT RATHER
THAN THE CURRENT STATE.** Two later batches grew the corpus. The deterministic-resolver batch
added the target-list duplicate control; the terminal-closure batch added three G4 containment
reproductions, an isolating control for the guard-callee comparison, five controls that drive each
loader accessor alone and four that drive R5's missing direction. **The current figures are in the evidence table below and NOWHERE ELSE.** A second copy used to
stand here, and it drifted from the table in every round that touched either — twice while the
round's whole purpose was correcting counts. A figure stated in two places is a figure that will
disagree with itself; the derived-figure test reads every occurrence for exactly that reason, and
the way to stop failing it is to state each number once.

### The evidence, counted

> **Historical snapshot.** The figures in this table are those of the round that wrote it;
> they are not current authority and no test reads them — see the record-authority notice
> above.

| Where | What |
|---|---|
| guard self-test corpus | **123 SYNTHETIC fixtures** — 119 verdict fixtures (89 refusals / 30 acceptances, 44 of them analysed AS the factory) plus 4 exemption fixtures — **262 assertions**. The real repository is checked ALONGSIDE them, by its own assertions; it used to be counted as though it were one of the fixtures, which made the corpus sound one larger than it is |
| G3 catalogue controls | **40** — one CLEAN control over the real catalogue unmodified, plus 39 drives that must each be refused: 29 splices into a copy of it, one that hands the audit a routine map with a row missing (because a comparison that is skipped when its mapping is absent is a rule that a deleted row removes silently), seven for the CONDITIONAL STORED-RESULT verification the six slot-creating entrypoints now carry — skipped entirely, reading the wrong sealed field, a return that recomputes instead of handing back the send's own result, a send-local colliding with a module binding, the verification running UNCONDITIONALLY with no refusal guard, the refusal check reading the wrong local, and the guard carrying an `else` branch — and two more a later adversarial review found: the three entrypoints with a second target-bearing field (`targetArray`) must verify the SAME set `noteSlotsOwned` claimed, not `targets` alone, so one mutant drops `targetArray` from the verify call and one drops it from the claim, each refused by shape — across entrypoint shape, parameter and local shadowing, the export surface, statement shape, holes, renderers and the `.query`-elsewhere rule. The guard-callee comparison NAMES the rule it drives instead of accepting any refusal — it could be deleted with every other splice still green, because every splice that reached it also broke a neighbour |
| G4 fixtures | **29** — the round-5 reproductions, the inherited-pin family (template hole, subscript, tagged template, template segment, string binding element, whitespace-then-`trim`, private field), the encoded-text family (a `U&` spelling in a plain string, and `\u005f`/`\x5f`/`\u{5f}`/`&#95;`/`&#x5f;` each driven alone), the folded compositions, and the acceptances that keep every rule a SHAPE rather than a ban on a word. **The itemised arithmetic that used to sit here is gone**: it drifted out of step with its own total in three consecutive rounds, and when the list and the total disagreed the list was always wrong. The total is DERIVED from the corpus and matched against this sentence by a test; a hand-written tally never was |
| mention inventory | **12 identities over exactly 26 pinned occurrences**, each identity carrying its own written rationale and its own count, checked in BOTH directions on the real tree. **The count is part of the pin** — see below; this table used to say the opposite, and the reason it gave was wrong |
| mention-count controls | **5**, driving the totals comparison directly. It compares whole-tree totals, so no per-file fixture can reach it — a rule only the CLI could run is a rule only a green run exercises, and a green run cannot show what it would have refused |
| lexer boundary cases | **21** — the 17 retained, plus four for the unicode-escape decoder rewritten as one left-to-right scan |
| oracle boundary controls | 4 — three retained; the sentinel-protocol depth control is deleted with its subject and the nested-body pair remains |
| R5 import-surface controls | **21**, three of them against the REAL runtime modules (authority, factory, catalogue), five driving each loader accessor ALONE, and four driving the MISSING direction the rule did not used to have |
| scope-drift controls | **29** — the sibling-file tripwire, driven over a CLOSED executable-extension contract. `.ts`/`.tsx` were the whole sweep once; `.mts`/`.cts` were added when a round found them unread; `.js`, `.jsx`, `.mjs` and `.cjs` when the NEXT round found the same hole again. Guessing a third time would have been the same mistake, so the executable set and the inert set are both closed and an extension in neither is refused BY NAME — one case drives that, another drives an inert `.json` so the rule stays a contract about code and not a ban on files. Also here: a sibling that SPELLS a writing routine, one that spells the shipped lifecycle wrapper and is not refused, a `.tsx` carrier whose only fault is JSX element text, and a second hiding the underscores as JSX entities in an attribute |
| catalogue runtime controls | **32 tests** — the digest inventory, the export pin, the both-directions drive of digests AND bound values, the sealed-argument controls, three ownership matrices, the renderer-hostility matrices, a STORED-ROW group of three (a read-back reporting a target id another identity already claimed, driven once directly and once across the full six-entrypoint verifying inventory; and a refused apply that never attempts the read-back at all, driven across that same inventory), and five more successive adversarial review findings required — a hostile `__proto__` own property retargeting the sealed copy's actual prototype, so a field never truly supplied could still answer through a stateful getter on every subsequent read; a `Buffer` carrying extra own properties disguised as a rendered array, surviving the seal's Buffer pass-through unchanged for the identical reason; and a three-control group over the byte copy that replaced it — an own `valueOf` returning an attacker-held `ArrayBuffer` (the arm that discriminates `Buffer.from` from `Buffer.copyBytesFrom`), an own `Symbol.toPrimitive` (named in place as a boundary control that does NOT discriminate today, since `Buffer.from` never consults it for a `Buffer`), and one proving the sealed value stops tracking both the source and its backing buffer — the export walk's own `constructor` special case is gone too, closing the own-data-property-named-`constructor` gap the walk used to skip unread |
| slot-fixture runtime controls | **22 tests** — the refusal matrix, the id-capability matrix, the digest-based byte-equality control (raw texts are no longer exported to compare against), the export pin, the foreign-id sweep, a driver-level-coercion group (`toPostgres()`, `Symbol.toPrimitive`, a two-faced `toString`, and two-faced `get id()`/`get trainer()` getters, each proved refused or read exactly once by instrumenting the hostile method itself), and a STORED-ROW group proving the database's own answer is judged, not only the argument sent (a drifted stored trainer, a colliding stored id, and a drift-plant refusal when the server holds no row) |
| factory export-surface controls | **4** — the control plus three mutants: the raw `SLOT_STATEMENTS` map re-exported (the direct bypass this design exists to close), an unrelated new export (the pin is an equality, not a deny-list of SQL-shaped names), and a pinned entrypoint dropped from the export list (the missing direction) |
| foreign-id sweep | total over the whole function-export surface — the 19 writing entrypoints plus the pure reader — in both outcomes (refused before sending, or the id in no sent text and no sent value, compared canonically) |
| ephemeral mutation battery | **109 mutants, 109 killed, 0 unnoticed, 0 stale, 0 restore failures**, each with ONE named sensor. Two of them exist because a rule can be right and its WIRING still absent: the count comparison is driven by its cases, and a separate mutant removes the CLI's call to it and is caught by an inverted sensor that appends one more occurrence to the real tree and requires a refusal |

**The battery harness itself carried a defect, and it is recorded because it manufactured false
results in both directions.** `execFileSync` defaults to a 1 MB `maxBuffer`; the database-backed
sensor prints every PostgreSQL notice from a full lineage replay and exceeds it, at which point
Node KILLS the child and throws with `killed: true` — which the harness could not tell from a real
timeout. Before this batch the catch returned "not failed" for a kill, so an overflowing sensor was
reported as a **SURVIVOR**; after the kill was given its own outcome it was reported as
**INCONCLUSIVE**. Both were false: the two resolver mutants concerned are killed in thirteen
seconds when run by hand. The buffer is now 512 MB, a kill is retried twice with a pause and only
then reported inconclusive, and the lesson is the harness's own version of this batch's theme — a
reader that cannot tell "I did not see" from "there was nothing to see" will report the second.

**Two mutants were RETIRED rather than counted, and both were the mutant being wrong** — which is
the same lesson the two previous batches wrote down, and it is recorded here because a battery that
quietly drops its own failures is worth nothing:

- **M03** (re-admit the bare `unnest` spelling to `unnestAliases`) is **UNREACHABLE**. The
  qualification rule refuses a bare `unnest` in every guarded surface first, so no input
  distinguishes the two states. The reachable half of that rule — a schema-qualified LOOKALIKE — is
  sensed by `M29` and by `g2-unnest-lookalike-in-another-schema`.
- **M13** (relax the entrypoint length rule) is **EQUIVALENT**. Recorded as it was measured, on a
  tree where an entrypoint was three statements and the mutation was `!== 3` to `< 3`; the rule now
  demands four and the equivalent mutation would be `< 4`. The argument is unchanged either way:
  the pinned positions are read by index, so an extra statement can only stand after the return and
  is dead code, and one that SENDS is caught by the `.query`-elsewhere rule.

**And one mutant found a redundancy this batch had introduced, which is why the battery exists.**
`M35` disarms G2's PL/pgSQL dynamic-statement detector, and it SURVIVED: the new qualification rule
was refusing an unreadable function body too, so G2's own detector had lost its sensor — *a
redundant gate hides its own mutation*, the round-8 lesson, reproduced by a rule written in this
batch. Every DECIDED failure path of the qualification rule is now conditioned on the word
`unnest` — the one exception is its walk-depth catch, which refuses a literal whose parse tree is
deeper than the shared walk descends whether or not the word appears, because an unfinished read is
not an empty one. That arm is fail-closed by construction and is stated here rather than implied,
and
`M35` is killed by `g2-dynamic-execute-in-a-function-body` again.

**Three further gaps were found the same way and closed**: the catalogue's not-a-SELECT arm, its
export-surface EQUALITY (as distinct from the statement-export rule that shadowed it), and G4 over
the scope-drift set — which was dormant exactly as the write-side tripwire once was, and now has
its own case in a throwaway tree with a near-name control beside it.

**A real defect in this batch's own new file was caught by the shipped guard**, not by review: the
catalogue's runtime test used a computed member access (`canonical[name](…)`), and `checkScopeDrift`
refuses any `abc27*` file outside the program that obtains a member it cannot show is not `query`.
It is written with an `Object.entries` walk and a `Map` instead, and the note lives beside the code.

### Gates, on the final bytes

> **Historical snapshot.** The figures in this table are those of the round that wrote it;
> they are not current authority and no test reads them — see the record-authority notice
> above.

| Gate | Result |
|---|---|
| migration pin | `05e04451f944cabf` / 20,633 lines — re-verified, byte-exact; no file under `supabase/` is touched |
| `abc27SlotFixtures.ts` | byte-exact against the preserved capture **except the two authorized `pg_catalog.` qualifications** — proved by reversing them and matching the preserved sha256 `83f3a33e…` exactly |
| `abc27TrainerAuthority.ts` | byte-exact except **one line**, the owner-amended third qualification — proved by diffing this batch's patch against the preserved patch, which differ in that line and in the mechanical blob/hunk headers alone |
| both, after every battery mutation | restored and sha256-verified per mutant and again at the end: 0 restore failures |
| `npm run check:trainer-authority` | ✓ 19 guarded WRITE statements in the factory (its statement inventory is 20 constants — the trigger DEFINITION is not a write, and the two numbers are pinned separately on purpose), 1 declared exemption, 7 audited catalogue statements, 7 typed entrypoints, 12 pinned mentions over 12 identities seen, `libpg-query@18.1.4 (PostgreSQL grammar 180004)` |
| `npm run check:trainer-authority:selftest` | ✓ 262 assertions over 123 SYNTHETIC fixtures, plus the real repository checked on its own — the two used to be added together, which made the corpus sound one larger than it is |
| CI workflow contract | ✓ (`rehearsalSharding`, in the unit project) |
| `eslint .` | ✓ 0 findings (exit captured directly, not through a pipe) |
| typecheck (structured baseline, never bare `tsc`) | ✓ 82 pre-existing, baseline 82 — no new type errors |
| `npm run build` | ✓ |
| unit suite | ✓ 393 files / 4,155 tests — MEASURED, not derived: `npx vitest run --project unit` is its own CI step with its own multi-minute cost, and re-running it inside the guard's self-test to derive this number would make a bounded tripwire pay for a suite it does not otherwise need. The two prior batches' figures above are snapshots for the same reason and carry the same caveat. This snapshot is from the runtime-containment batch recorded below, on the same tree — the two batches share one unit run because they share one tree |
| **full db suite — the three-consecutive-run protocol** | run AFTER this document is final, and its result is recorded OUTSIDE this repository — see "why no run table lives here" below |
| mutation battery | ✓ 109 mutants, 109 killed, 0 unnoticed, 0 stale, 0 restore failures |

### The terminal closure — what two review rounds found, and what each fix actually was

Rounds 2 and 3 reported findings that were NOT this batch's resolver work: they were pre-existing
claims and rules that had never been driven. They are closed here. Each one is stated with the
thing that was wrong, because "hardened" is not a finding and "fixed" is not evidence.

**G4 could be walked straight past, and the identity was why.** The mention identity was
`(kind, text)`, so one text meant one decision wherever it appeared. It does not. The bare wrapper
name as a CATALOG INVENTORY ELEMENT is inert and is pinned on that ground — identity
`823468e8c6b7f7a7`, genuinely in the pinned set. The same characters in a TEMPLATE VALUE HOLE are
a complete invocation:

```
client.query(`SELECT * FROM public.${"rebook_round_apply_command_as_actor"}()`, []);
```

That returned **zero violations**. The hole folds to a neutral atom so the composed text never
spells the routine, and the string token inherited the inventory element's pin. A REGEXP literal
was a second route — `/rebook_round_apply_command_as_actor/.source` is the same text with
different punctuation, and the walk never visited a `RegularExpressionLiteral` at all. A subscript
was a third: `CALL['…']` READS the stored call text under a pin written for an inventory entry.

**Adding positions to the identity was necessary and NOT sufficient, and a further round proved
it.** A pin still decided a TEXT, so every further occurrence of an already-justified text was
accepted without anyone deciding anything — and an occurrence can be an entirely different act:

```
for (const routine of ['rebook_round_apply_command_as_actor'])
  await c.query(`SELECT * FROM public.${routine}()`, []);
```

That inherits the inventory element's pin and reported nothing. So did the same shape through
`Object.keys({<name>: true})` on the map-key pin. Three more were pure token-form gaps: a template
SEGMENT (`` `<name>${''}` ``), a tagged template, and a binding element's quoted property name all
reached the plain-string arm. And `' <name> '.trim()` hashed identically to the bare name, because
the identity folded whitespace before hashing — folding belongs to display.

**What closes the class is that the COUNT is pinned with the text.** Each of the twelve identities
now pins how many occurrences were justified — 26 in total — and any change either way is refused.
A new occurrence of an already-justified name is a new SPELLING nobody has looked at; a
disappeared one is a rule that stopped being exercised.

**What this does NOT close, said plainly.** The count is about spellings, not about uses. Code that
reuses an existing binding — `WRAPPERS[0]` handed to a new query — writes no new occurrence of the
name and the total does not move. That is the dataflow question this guard has always refused to
answer, and it is the reason the guard's own summary line says it makes NO dataflow claim: what
stops a reused binding from writing is the runtime ownership check, which asks about the value that
actually arrives. This record previously argued against counting, on the
grounds that it "would churn on every unrelated edit in a 30,000-line file". **That was simply
wrong**: the number moves only when an occurrence of a writing routine name is added or removed,
which is exactly the edit that should be looked at.

Alongside it: the identity keeps the node KIND (a quoted string, a whole backtick template and a
template segment were one category), keeps the POSITION as a sorted set of every matching ancestor
rather than the first, no longer folds whitespace, and the walk visits regexp literals, private
identifiers, JSX text and a binding element's literal property name. All eight shapes above are
refused, each by its own fixture, and each rule has a mutant that names it.

**A second load-sensitive control, of the class this batch exists to remove.** Described above:
every settable timeout was written as `'1ms'`. Fixed, with a read-back that requires none to be
left short enough to fire.

**The seal accepted a third thing while documenting two.** The contract is strings or a deliberate
`null`; `undefined` was accepted by the same arm as `null`. `node-postgres` sends an undefined
array member as SQL `NULL`, so an element nobody decided on arrived indistinguishable from one
somebody did. It is refused, with its own message and its own control.

**"node-postgres cannot express a multidimensional array" was untrue, and so was its first
replacement.** Measured against the installed driver: `prepareValue([['a'],['b']])` returns
`{{"a"},{"b"}}`, so multidimensional is expressible; and `prepareValue('[0:1]={a,b}')` returns the
string untouched, so a non-one-based array can be bound as TEXT. The true claim is that a native
JavaScript `Array` does not serialize a lower bound. It was written in FIVE places, not four — a
review round found the fifth, in the checker's own G3 header, still carrying the original wording
after the others were corrected. The "four cannot be parameterised" count was also one too many:
the refusal probe renders a single UUID.

**Three rules had no case, so 56/56 did not mean what it sounded like.** A mutation score measures
the mutants written, not the rules that exist. The guard-callee comparison could be deleted with
all twenty-eight G3 controls still green, because every splice that reached it also broke a
neighbour — it now has a control that requires the reported detail to be ITS message. Three of the
five loader-accessor names had no case and the two that did shared one `>= 1` assertion, so either
was individually removable — each is now driven alone and counted exactly. The renderer-local
`.query` rule was **deleted**: `visitQuery` walks the whole module, so every input that could trip
the renderer rule tripped the module-wide one first, and no fixture could ever distinguish them.
An unsensed rule is not defence in depth, it is an untested claim.

**R5 was half a pin.** It rejected unexpected imports and never required the expected ones, so a
module that imported NOTHING passed — including one that quietly stopped obtaining
`./abc27TrainerAuthority`, which is where the ownership check lives. It is an equality now, sensed
in both directions.

### The third and fourth rounds, which found defects rather than wording

Rules that were right and unreachable, renderers that lost valid values, and a harness that
measured the wrong thing. Each is stated with what was actually wrong.

**Two array presentations did not preserve values the validator ACCEPTS.** `PLAIN_LABEL` is
`/^[A-Za-z ]+$/`, and the multidimensional and zero-based renderers wrote their elements into
PostgreSQL's array-INPUT syntax UNQUOTED. Three accepted labels did not survive: `NULL` — four
ordinary letters — became the SQL null, so `{{NULL},{X}}` read back as `[[null],["X"]]`; leading
and trailing spaces were stripped; an all-space label rendered `{   }`, which is not valid input.
Almost every renderer case used UUIDs, which have none of these troubles — the one exception is a
zero-based DATE in the realpg shape matrix, and a date carries no space, no `NULL` spelling and no
all-blank form either, so nothing drove it. Elements
are quoted now — lossless, since a label cannot contain a quote, a brace or a comma — and a control
asserts the rendered text for all three.

**`uuidLiteral` had no case at all.** Every hostile-value control goes through `renderArray`; the
`academy` and `round` holes go through `uuidLiteral`, and replacing its body with plain quoting
left the suite AND G3 green — G3 asks only that a hole be a direct call of a named private
renderer, which is a question about shape and cannot be a question about what the renderer does.
Four values now drive it: one that would close the literal and start an expression, one carrying a
`--` sequence (which does NOT comment anything out on its own, since it stays inside the quotes —
it is there as a shape that must still be refused), and two that are merely not canonical. Three
acceptances go with them — a lower-case `randomUUID()`, an UPPER-CASE one and a mixed literal —
because the validator documents either case and only the lower-case form was ever driven, so
lower-casing the renderer would have stayed green.

**G3 accepted either writing routine.** Each statement's entrypoint was recorded beside it and then
never read, so a statement could keep every structural property — one plain `FROM` call, closed
arguments, its own routine exactly once — and invoke the OTHER routine. The two have different
privilege surfaces. Each entrypoint is now pinned to the routine it is entitled to, and swapping
the core statement to the wrapper is refused with its own case.

**The raw-text-export walk stopped at depth four and looked for one word.** Anything nested below
the cut-off was not examined — the cut-off silently CERTIFIED what it declined to read — and the
test searched for `select`, so a bare routine name or a `VALUES(public.<routine>(…))` was not
statement-shaped by that definition. The walk is total now (cycles guarded rather than depth) and
looks for every SQL verb that carries a call as well as either routine name, taken from the guard
rather than spelled — spelling them was itself a mention outside the catalogue, and G4 said so.

**The fourth round found the walk that replaced the depth cut-off was still not total, and that
two validators were patterns where a pattern cannot decide.** `Object.values` reads neither KEYS
nor `Map`/`Set` contents nor symbol-named properties, so a statement exported as a key satisfied
every other pin; the walk now reads all of them, through a descriptor rather than a computed
member — a computed member is the shape the scope rule cannot clear, and it refused this file for
it, correctly. Its patterns were bare words, which over-reject the moment keys are read (`values`
is an ordinary field name), so each verb is now required with the syntax that makes it a
statement and each routine name with identifier boundaries. The ISO-date pattern accepted
`2026-99-99`, leaving the refusal to PostgreSQL after the statement was built and sent; it asks
the calendar now. `LOWER_HEX` accepted an ODD number of digits, which matters for precisely the
input it exists for — a Buffer whose `toString` is overridden and can return `'a'`.

**Two rules failed OPEN, which is worse than being wrong.** The entrypoint-to-routine binding
skipped its comparison entirely when a mapping was missing, so deleting a row removed the rule
silently; a missing row is a refusal now. And the identifier-boundary class was hand-assembled
three times and was wrong all three: ASCII, then letters and numbers and marks, then those plus
connector punctuation and the joiners — still missing U+00B7 MIDDLE DOT and the rest of Unicode's
`Other_ID_Continue`. An incomplete class here does not over-report; it REFUSES code that names
something else. It asks Unicode for `ID_Continue` now.

**And one arm was deleted rather than kept untested.** A JSX-attribute arm was added in the second
round; disarming it changed no case, because an attribute's value is an ordinary `StringLiteral`
the first arm already visits and the entity decoding now applies to every token. It went the same
way the renderer-local `.query` rule did.

### The bounded closure — three defects, two fail-open rules, and a record that stops drifting

**The bytea renderer trusted the one method it was written to distrust.** It exists because a
`Buffer` SUBCLASS can override `toString` — `Buffer.isBuffer` accepts one — and it then called
that override. Worse, it VALIDATED one coercion and RENDERED another: the result was not
necessarily a string, and `LOWER_HEX.test(hex)` coerces while `${hex}` coerces again. Measured, a
stateful `Symbol.toPrimitive` answered `aa` to the test and `aa'::bytea); …` to the template. The
hex now comes from the intrinsic captured at module load and applied with `.call`, a non-string
result is refused, and the value is rendered as `pg_catalog.decode('<hex>','hex')` — which
contains no backslash, so it cannot mean different bytes under a different
`standard_conforming_strings`. A real-server control evaluates the renderer's OWN output under
both settings and requires the same bytes.

**Two of those three guards are unreachable, and that is stated rather than implied.** With the
intrinsic in place the hex is a lower-case, even-length string by construction, so the `typeof`
test is reachable only if the intrinsic is bypassed (a mutant does exactly that, and it is what
catches it) and the even-length test is reachable behind neither. It is kept because a renderer
whose whole purpose is to distrust a caller-supplied method should not depend on the intrinsic
never being edited away — but no mutant claims to sense it, because none can.

**The entity decoder crashed the guard on ordinary text.** `String.fromCodePoint` raises
`RangeError` above U+10FFFF, so a file containing `&#xFFFFFF;` stopped the analysis instead of
being analysed. Out-of-range values and lone surrogates are now left exactly as written — which
can under-decode but never mis-decode — and a fixture proves a text carrying BOTH an undecodable
escape and a real spelling is still refused.

**Two rules failed open.** The entrypoint-to-routine binding skipped its comparison when a mapping
was missing, so deleting a row removed the rule silently; and the sibling sweep read `.ts`/`.tsx`,
then `.mts`/`.cts`, while `.js`, `.jsx`, `.mjs` and `.cjs` stayed invisible — the same hole found
twice. Both sets are CLOSED now and an extension in neither is refused by name, so a new
executable kind is a decision rather than an omission.

**The export walk certified what it declined to read.** Keys, `Map`/`Set` contents, symbol-named
properties, function properties and accessors were all skipped. It reads them all now, through a
descriptor — never a computed member, which is the one shape the sibling-scope rule cannot clear,
and which it refused this very file for — and a property kind it cannot read is REPORTED rather
than passed.

**The record's figures are no longer maintained by hand.** They drifted in four consecutive rounds;
each correction was followed by another drift — including, in the same round that closed the drift
after this sentence, the COUNT of derived figures this sentence used to state: it said "eleven" when
the list had grown to thirteen, and a hand-maintained count of hand-maintained counts is the same
mistake one level up. So no count is stated here at all: every figure in the evidence table below
is DERIVED from the corpus and matched against the sentence that states it, so the record cannot
disagree with the code without a test going red. Two figures are deliberately not among them, each
for a stated reason rather than an oversight: the mutation total, because the battery is ephemeral
and not checked in, so nothing in the repository can derive it; and the unit-suite test count,
because deriving it would mean re-running the whole suite — its own multi-minute CI step — inside
this tripwire. Both are stated as MEASURED rather than DERIVED, and claiming otherwise for either
would be the same kind of untruth the guard exists to prevent.

**Superseded (2026-09-04).** The mechanism this paragraph describes — figures DERIVED from
the corpus and matched against the sentences that state them — is retired: no test reads this
document for a figure any more, and the figures above are historical. What holds now is
stated in the current section at the end of this document.

**Two lessons about the evidence itself, both learned the hard way here.** An expectation must not
be derived from the thing it judges — the first version of the hole-to-field control read the
declared order out of the module and checked the module against it, so swapping two holes swapped
the expectation with them and the control passed. And a check that asks only whether a file was
REPORTED passes for the wrong reason: dropping an extension moved those files into the undecided
arm, where a different rule reported them and the assertion stayed green. Both now read the
REASON, not the fact.

### What the first closure review found, and what it cost to be wrong

Every item below is a defect this batch INTRODUCED or left, found by a review of the batch itself.
They are recorded because each one is a lesson about the evidence, not about the code.

**The closed extension contract regressed the sweep it was meant to widen.** Folding "is this an
`abc27` file" and "which extension" into one pattern — `^abc27[^.]*(\.[^.]+)$` — permits exactly
ONE dot. Two files in this tree carry compound names (`abc27ApplyCatalogue.runtime.test.ts`,
`abc27SlotFixtures.runtime.test.ts`), they are not in the analysed program either, and for the
length of that regression they were checked by nothing at all. A file under an `abc27*` DIRECTORY
was skipped for the same reason. The name and the extension are separate questions now, the name
is asked of the whole path, and both shapes have a case.

**Three renderer arms validated nothing that any test drove.** Every hostile-value case used
`kind: 'literal'`, so the `with-null` arm and the shared `quoted` helper — the other three
presentations — could have had their `scalar(...)` calls replaced by the raw value with the whole
suite still green. Each presentation is now driven with a value that is not a UUID.

**A fail-closed branch that nothing could reach is not evidence.** The missing-mapping refusal was
guarded by a completeness test proving the map is whole — which says the branch cannot FIRE, not
that it works. The audit now takes the routine map as a parameter, so a case can hand it a map
with one row removed and drive the branch directly.

**The export walk was still not total, twice over.** It read own keys but not the PROTOTYPE chain,
so `Object.create({ sql: 'SELECT …' })` carried recoverable text past it; and it reconstructed
identifier boundaries in ASCII, reintroducing exactly the false-positive class the checker's own
boundary was fixed for — `…_core·suffix` is an ordinary longer identifier. It follows the chain
now, bounded at the intrinsics, and uses the same `ID_Continue` class.

**A figure stated twice will disagree with itself.** The derived-figure guard read only the FIRST
occurrence of each pattern, and a second copy of the corpus figures lived in a paragraph above the
evidence table — which had drifted from it in every round that touched either, twice while the
round's whole purpose was correcting counts. The guard reads every occurrence now — several figures
still are stated more than once, deliberately, once in a narrative sentence and again in the
evidence table's own row, and both copies are checked against the same corpus figure rather than
against each other, so a second copy left behind by an edit to the first is exactly what goes red.

**And two rules were deleted rather than kept untested.** The CLI's stale-pin branch reported a
pin nothing produces, which the occurrence-count comparison already refuses as `pinned N, found 0`
— two rules for one condition means one of them is never the reason anything failed. The
even-length hex test survives but is now labelled for what it is: unreachable behind the intrinsic
and the non-string test, kept as a fail-closed second line, sensed by nothing and claiming nothing.

### Why no run table lives here

**THE DOCUMENT CANNOT RECORD A RUN OF THE SUITE THAT READS THE DOCUMENT.** The realpg suite reads
this file, so a result written here after the runs makes the runs describe a file that no longer
exists. Three review rounds circled this. The first version added the table afterwards and claimed
it was "on the final bytes", which was untrue. The second finalised every paragraph, left a
placeholder and filled it, and claimed "a single line, changing no assertion input" — also untrue:
three rows are not one line, the placeholder was REPLACED rather than added to, and the rows do
change the string `RUNBOOK()` returns, even though they change no assertion RESULT.

Each attempt made the sentence narrower and each was still false, because the paradox is not in
the wording. **So the REPEATED-RUN PROTOCOL RESULT is not written here at all.** Gate figures in
the table above are measured and fixed BEFORE the final review and never revised after it; the
three consecutive full-database runs happen after that review, on the exact reviewed bytes, with
no repository edit of any kind following them, and their outcome is reported to the operator and
to the durable session record instead.

**That is a claim about the terminal protocol, not about every number on this page**, and an
earlier wording said "no run result lives here" flatly while the two paragraphs below record a
discarded run's duration and a failed test. Both of those are DIAGNOSES written before the final
review and never revised after it, which is the property that matters; the thing that cannot be
written here is a result the protocol produces after the document is frozen.

**Two lessons the runs themselves taught, which are not run results and do belong here.**

**The triple is a terminal gate and runs with nothing else on the host.** One run was discarded
after `d7Performance.realpg.test.ts` — `measures materialize(N, 500) over N adverse rounds and
picks the largest N under budget` — took **1,224,256 ms**. It had been started while four review
sessions were working on the same repository, with the host at load average 21 and swap exhausted
at 14.5 GB of 15.3 GB. That test is a BUDGET probe: under that load it measures the machine, and a
green result would have been as worthless as the red one.

**A SECOND LOAD-SENSITIVE CONTROL EXISTED, AND IT IS NOW FIXED.** A run failed one test —
`the timeout vocabulary is the server's own, and the witness names a write of each` — with
`Client has encountered a connection error and is not queryable`. The server log gave the cause
without ambiguity:

`2026-09-02 20:16:56.659 CEST [2767] FATAL: terminating connection due to idle-session timeout`

That control set **every** settable timeout GUC to `'1ms'`, and the damage was never confined to
one GUC: `settable` is ordered by name, so `idle_session_timeout` is written third — after which
every remaining round trip had one millisecond to ARRIVE — and `statement_timeout` fifth, after
which every remaining statement had one millisecond to COMPLETE. That the control ever passed was
a statement about a loopback socket being faster than a millisecond. It is the same defect class as
the psql-resolver control, found the same way.

**The value was never the point.** What the control proves is that the vocabulary is derived from
the server and that the witness can NAME a write of each entry, and the witness records
`SET <name> = $1` whatever the value is. So every timeout is now written with a value that cannot
fire inside the test, and the control additionally READS EACH ONE BACK and requires that none was
left short enough to fire — because the witness proves a statement ran, not that the server kept
its effect. Nothing was dropped: `idle_session_timeout` is still derived from the catalog, still
written through `format('%s')`, and still required to be named by the witness.

Measured on this host, seven of the eight hold 600000 ms and `tcp_user_timeout` holds 0 — the
platform has no `TCP_USER_TIMEOUT`. **Zero is "disabled", not "immediate"**, so the read-back
treats a short POSITIVE value as the danger and 0 as the safe outcome it is; an earlier version of
this check called that 0 dangerous and was wrong.

**THE LOAD-SENSITIVE RESOLVER CONTROL IS NOW DETERMINISTIC, AND THE ACCOUNT THIS RECORD GAVE OF IT
WAS WRONG.** Both halves matter, and the wrong account is the more important one.

**What this record said, and why it was false.** It said the failing test resolved `psql` from the
pinned fallback list under a 15 s per-probe and 30 s aggregate budget, that `invoked: false` was
that 30-second budget elapsing, and that the test was "a pure function under a stopwatch: no
database, no reader". It also cited `:13380` and suggested the owner might widen the budget. A
review round checked the source instead of the prose and found every one of those claims untrue:

- The test never used the fallback list or the production budget. It wrote three fake shell scripts
  into a temporary directory and called the resolver with **its own candidates and `budgetMs:
  1_500`**.
- `invoked` was `existsSync(marker)` — whether a spawned `/bin/sh` had been scheduled far enough to
  append one line **inside 1.5 seconds**. Nothing to do with the real client.
- It created files and spawned child processes, so "a pure function under a stopwatch" was wrong.
- The 0.02 s measurement of the real binary, offered here as the decisive fact, was of a code path
  the failing assertion never executed.
- Consequently the remedy this record floated — widening the 30 s default — **would not have
  changed the test at all.**

That is a false causal claim in an evidence record, and it is recorded rather than quietly
corrected because it is the second time this batch's prose drifted from its code and the first time
it drifted in a way that would have misdirected an owner decision.

**What the control does now.** The resolver takes two test-only seams — an injectable probe and an
injectable clock — and the two BUDGET drives assert the DEADLINE ARITHMETIC instead of the
operating system's scheduler. **No temporary file survives anywhere in the test, and no child
process, wall clock or scheduling question enters either budget drive.** The production defaults
are untouched and are not overridden by the main drive, so the arithmetic asserted is the
arithmetic production performs:

| Drive | Budget | What the ledger must show |
|---|---|---|
| full | the real 30 s, with the real 15 s per-probe bound | two probes — `psql-a` at 0, `psql-b` at 15 s, 15 s each — the third refused with `resolver budget spent`, and 30 s consumed in total |
| partial | 20 s, which does **not** divide by 15 s | `p1` granted 15 s, then `p2` granted the **5 s that remain** — which only an implementation that subtracts can produce |

The partial drive is what makes the ledger a sensor rather than a restatement: under the full
budget both probes are granted the same amount, so a resolver that forgot to bound a probe by what
is left would produce an identical ledger. **20 s is narrower than the 30 s default, not wider**;
neither default moved.

**The claim is about the budget drives, and the rest of the test is stated rather than glossed.**
Two arms of the same test still call the real `spawnSync` on purpose, because they ARE the retained
execution coverage the seams must not replace: a path that does not exist and a DIRECTORY. Both
fail in the PARENT with ENOENT/EACCES — `spawnSync` returns without ever creating a child — so
nothing is scheduled and the arms cannot race. They do read the real clock, though, and under the
1.5 s budget they used to carry, a 1.5 s pause between the deadline and the probe would have
returned `resolver budget spent` where the assertion demands `--version did not answer`. **That arm
now takes the real 30 s default instead**, which removes the cliff and widens nothing — 30 s IS the
production default, and declining to narrow it is not the same as raising it. The empty-candidate
arm reaches no probe at all and so has no timing question to begin with.

**Execution coverage did not move either.** The `\gset` control LATER IN THIS FILE drives this same
resolver against the live cluster through eleven real psql invocations, and it is unchanged. What
was removed is a scheduler race, not a real-client path.

**Evidence.** Five mutants, each with one named sensor: budget reset per candidate, a probe not
bounded by what remains, the spent-budget refusal removed, the injected clock ignored, and the
injected probe ignored. The resolver's byte digest and the control callback's digest both moved
with the change and were re-pinned, then verified twice — which is the envelope guard doing exactly
what it exists for: no edit to that function is possible without re-pinning it deliberately.

### Deviations from the implementation envelope, stated rather than absorbed

- **The catalogue imports `node:crypto`.** The envelope pinned its imports to `pg` and the
  authority module; publishing digests instead of texts requires a hash. R5 pins all three, and
  the catalogue-imports-the-checker case is driven in both directions like the other two modules'.
- **G3's controls are splices into a copy of the REAL catalogue, not fixtures.** G2's rules run
  against any file the analysis is TOLD is the factory, so its adversarial cases can be fixtures;
  G3's are about a whole MODULE, which a one-function fixture cannot be. Splicing the real source
  is strictly better evidence and is the technique the retired census battery already used.
- **The envelope's battery mutant 4 ("guard moved after `query`") is caught STATICALLY**, because
  G3-c is stronger than the envelope anticipated: an entrypoint is exactly four statements, so a
  hoisted send is a shape refusal. To keep the RUNTIME ownership controls sensed rather than
  shadowed by a reader, a distinct runtime mutant was added instead — an entrypoint that guards its
  TARGETS instead of its SOURCES, which is structurally clean and only the runtime foreign-slot
  control can see.
- **Step 0 of the envelope's sequence (a checkpoint commit) was NOT performed**, because the
  authorisation for this batch forbids committing. The preserved round-5-stop bytes are captured
  instead as a hashed patch plus a per-file sha256 manifest for the tracked and untracked sets, and
  the deleted census module's digest is recorded above so its removal stays auditable.

### Residuals, restated

The honest claim has not widened. **G4 makes no dataflow claim of any kind**: a routine name
assembled at run time out of fragments that never spell it is the named residual, and it is the
same residual class the slot-write promise already carries. The composition detector folds the three
shapes the retired scans were actually defeated by — `+`, `[…].join(…)` and `.concat(…)` — and
reports what it can fold; over-reporting there is safe. What actually stops one test from writing into another's
namespace is unchanged and is not static: `requireOwnedByCurrentIdentity`, `assertSlotsNotForeign`
and `noteSlotsOwned`, at execution time, in every run, on the values that actually arrive — which
is why every catalogue entrypoint calls two of them before it sends. Barrier 10b remains
separated and untouched. The psql-resolver control does **not** — it was rewritten in the
deterministic-resolver batch recorded ABOVE, which is the one deliberate exception to this
paragraph's "untouched" claim.

## THE RUNTIME CONTAINMENT BATCH — closing what the bounded-certifier closure left open

**STATUS: implemented, and every evidence gate below measures green on the final bytes — guard,
self-test, lint, typecheck (structured baseline), the certifier's own real-tree check, the full unit
suite, build, edge pins, full-database repeatability and the mutation kills.** Three fresh review
rounds were budgeted and three were spent; the third found one open P1 and one open P2 (both
reproduced, fixed, mutation-verified, then DELIBERATELY REVERTED per the authorization's own rule —
*any actionable finding after the final round stops, with no post-review edit* — the same
discipline this document's own "## THE ROUND-5 STOP" section already established once; see
"### The round-3 stop" near the end of this section for the full account). **A separate, explicit
authorization then granted one exceptional fourth review, scoped only to these two findings**: both
fixes were re-applied exactly as drafted the first time, re-verified by mutation kill, and this
section's own evidence re-measured green. That fourth review returned NOT CLEAR on both — a
coercion escape in the first fix's own copy primitive, and a universal claim the second fix had
left standing one paragraph further down — and stopped without editing, as its rule required. A
further authorization scoped exactly those two for closure and granted a fifth review, which closed
one and returned NOT CLEAR on the other. Those remaining findings were then given their own bounded
closure batch — the byte-snapshot primitive and its controls — rather than another round of the
broad audit; "### The rounds after the third, and the batch that closed them" at the end of this
section is the account, and no review outcome is written back here. Local only: nothing
is committed, pushed, merged, deployed or applied, and no migration is touched. The frozen ABC-27
migration (`05e04451f944cabf…`, 20,633 lines), the `POST_ABC27_ALLOWED` span and the D7 convergence
files are byte-exact throughout.**

The bounded-certifier closure batch stopped at a Review B that was not clear, and its own record
named what it had deliberately left unfixed rather than pretending the batch covered more than it
did: a `toPostgres()` object and a two-faced `get id()` skip the ownership check and still reach
`pg`; `SLOT_STATEMENTS` was exported, so a caller outside the factory could import the raw texts
and send one on a connection of its own; G1 does not follow `EXECUTE ('…')` composed with `||`, nor
PostgreSQL's octal and hex string escapes; the R3 exemption was counted but not pinned to a
location; and `rehearsalSharding`'s `spawnSync` budget had no real timeout. A sixth item survived
from Review B itself: the export walk skipped any own property literally named `constructor`. This
batch closes all six, plus one the first five made necessary: the factory's own stored-row
verification had no counterpart in the apply catalogue, and DATABASE_AUTHORITATIVE_RESULT asks for
one there too.

### RUNTIME_AUTHORITY — one capture, one validation, one send

`abc27TrainerAuthority.ts` gains `capturedId(value, what)`: it returns `value` unchanged when
`typeof value === 'string'`, and throws otherwise — without ever reading a property, calling a
method, or coercing anything. That is the whole fix. The two escapes named above are both cases of
the SAME defect: `assertSlotsNotForeign` and `requireOwnedByCurrentIdentity` were written to accept
a `string`, but under this repository's `strict: false` a `string`-typed parameter admits an
object with no cast at all — so the registry SKIPPED a non-string on purpose (several fixtures
deliberately pass a `null` or a ghost UUID) while `node-postgres` went on to call the object's own
`toPostgres()` or `Symbol.toPrimitive` and serialize whatever it returned. The registry never made
a wrong decision; it was asked about a value it correctly judged inapplicable, and a DIFFERENT
value reached the wire.

`capturedId` closes it by moving the type down to `unknown` at every boundary that used to say
`string` on faith — `ownedSlot`, `owned`, `allOwned` in the slot factory; `capturedId` itself in the
authority module — and refusing anything that is not ALREADY a primitive before either the check or
the send touches it. A caller's PROPERTY is read exactly once, into a local, before validation: `s.id`
and `s.trainer` in `insertSlot`/`insertTemplateSlot` used to be read two or three times each — once
in a presence test, once in the check, once in the parameter list — and a getter answering
differently each time is the two-faced-`get id()` shape by name. Every entrypoint now captures each
field into a local in one pass and reads only the locals afterward, exactly the discipline the
apply catalogue's `sealed()` already enforced one layer up.

**Driven, not merely reasoned about.** `abc27SlotFixtures.runtime.test.ts` gained a dedicated group:
an object carrying `toPostgres()`, one carrying `Symbol.toPrimitive`, and one with a two-faced
`toString` are each handed as a slot id and as a trainer, and each is refused with its hostile
method's own call counter left at zero — proving the object is refused WHOLESALE, never consulted.
A two-faced `get id()` and `get trainer()` on `insertSlot`'s own options record are each proven read
exactly once, with the bound value equal to the FIRST (and only) answer.

**A THIRD way past "read once", found by adversarial review: the seal's own copy, attacked through
its prototype.** The apply catalogue's `sealed()` does not capture named fields into locals one at a
time the way the factory's entrypoints do — it copies every own enumerable key of the caller's
record via `Object.keys` into a plain `{}`, and an entrypoint then reads NAMED fields off that
copy repeatedly through its body (the claim, the render, the verify call). The copy step was meant
to make that safe: whatever the caller supplied is read once, during the copy, and every later read
is of inert data. But `Object.keys` does not distinguish an ordinary key from one literally named
`__proto__` — reachable through `Object.defineProperty`, not the `{__proto__: x}` object-literal
syntax, which sets a prototype instead of creating an own property — and assigning THAT key into an
ordinary `{}` reaches `Object.prototype`'s own `__proto__` SETTER, retargeting the copy's actual
prototype to whatever the caller supplied. A field the copy never held as an own property — because
the caller's own record never held one either, relying entirely on the poisoned prototype to answer
for it — then falls through to that prototype on every subsequent read, and a stateful getter there
can answer the claim, the render and the verify calls three different ways. Measured directly: a
hostile `applyNormalizedCoreShaped` spec with no own `targetArray`, a `__proto__` own property
pointing at a `Buffer` carrying a `targetArray` getter, and nothing else changed, called that getter
three times before the fix — once for the claim, once to render the statement, once for the stored
row it never verified. **The fix is one line**: `sealed()`'s copy target is now `Object.create(null)`
rather than `{}`, so there is no inherited setter for `__proto__` to hijack and no inherited getter
for a missing field to fall through to — the copied `__proto__` key becomes inert data like any
other, exactly as `id`, `trainer` or any other ordinary key already was. No new database object,
trigger, schema, role or permission; the fix is which object the copy loop writes into. Driven, not
merely reasoned about: the same hostile spec, reverted onto the pre-fix copy target, made the
getter fire three times and is now confirmed to fire zero, in a dedicated
`abc27ApplyCatalogue.runtime.test.ts` control.

### STATEMENT_AUTHORITY — the factory's raw texts left the export surface

`SLOT_STATEMENTS` is no longer exported. The factory now publishes `SLOT_STATEMENT_DIGESTS` — the
sha256 of each of the twenty constants, keyed the same way — which is the identical move the apply
catalogue already made for the identical reason: a digest cannot be invoked, and a raw text
re-exported under any name is a write spelled from this file's own bytes that G1 has nothing to say
about, because the bytes are exactly what G1 already audited. Every runtime control that used to
compare against the raw text now hashes what was actually SENT and compares the digest, in both
directions — nothing sent lacks a matching inventory entry, and no inventory entry goes unsent —
matching the apply catalogue's own two-directional drive exactly.

**The certifier gained a new rule to hold it: G1-e.** The factory's export surface is now pinned by
name, the same move G3-e already made for the catalogue, narrower because the factory's entrypoints
are not built to the catalogue's four-statement shape: it asks only which NAMES are exported, not
how each one's body reads. `FACTORY_EXPORT_SURFACE_CASES` drives it over spliced copies of the real
factory — the raw `SLOT_STATEMENTS` map re-exported, an unrelated new export (the pin is an
equality, not a deny-list of SQL-shaped names), and a pinned entrypoint dropped from the surface
(the missing direction) — each refused by shape.

### DATABASE_AUTHORITATIVE_RESULT — the stored row is judged, not only the argument

Every check described above happens before a statement is sent. None of it says anything about
what comes BACK: a `BEFORE` trigger rewriting `NEW.trainer_id`, or a server that hands back an id
another identity already holds, are both invisible to an argument-side check by construction — and
the suite already plants exactly such a trigger, deliberately, to model P-layer drift. So every
guarded write and every apply path that creates or changes slots now reads back what PostgreSQL
actually stored and asks the registry to judge THAT.

**In the factory**, every statement gained `RETURNING id, trainer_id` (`SLOT_UPDATE_CAPACITY`
already returned `id`; it now returns the trainer alongside it), so the read-back is the write's
own result — no second round trip, no second snapshot. `acceptStoredSlotRows` in the authority
module judges each returned row: the stored id must not belong to another identity, the stored
trainer must not belong to another identity, and — where the entrypoint named a specific trainer —
the stored trainer must be EXACTLY the one that was sent, so a rewrite to any OTHER trainer this
test does not own is caught even though a rewrite to a trainer nobody owns would not otherwise be.
`plantSourceDriftTrigger` is the one write with no client round trip at all — its `UPDATE` runs
later, inside somebody else's transaction — so it now reads the row back BEFORE planting, binds the
trainer it found into a fourth session setting, and the planted trigger's own `WHERE` carries that
trainer alongside the slot: the one guarded write with no per-call verification cannot move a row
between namespaces even if the fixture that planted it were ever wrong about which row it named.

**In the apply catalogue**, six of the seven entrypoints create or extend slots server-side and
now read back the target ids they named, via the SAME authority function
(`verifyStoredSlots`), immediately after the apply statement and on the same connection. This
required extending G3-c, which is why it is documented as a deliberate widening rather than a
quiet one: an entrypoint that creates or changes slots is now SIX statements — seal, the two
guards, `const <local> = await client.query(…)`, `await verifyStoredSlots(client,
<seal>.targets ?? [], '…')`, `return <local>` — checked structurally with the same rigour the
original four-statement shape carries: the send's own local may not collide with a module binding,
the seal's local, or the parameter; the verification must read the SEALED local's own `targets`,
never the raw parameter; and the return must hand back the send's own result, unchanged, so a
verified result cannot be swapped for an unverified one on the way out.
`applyCommandAsActorRefusalProbe` — the one entrypoint entitled to guard no slots, because it mints
every id server-side and names no client-controlled target at all — keeps the original four-statement
shape; there is nothing for it to read back.

**No new database object, trigger, schema, role or permission.** The mechanism is a `SELECT id,
trainer_id FROM public.availability_slots WHERE id = ANY($1::uuid[])`, held once in the authority
module, plus the registry's own in-memory `Map`s. A zero-row result is a pass and says so: several
fixtures deliberately name an id that matches nothing at all, and an apply that was AUTHORIZED but
matched nothing created no rows to judge.

**AN UNAUTHORIZED APPLY DOES NOT REACH THE READ-BACK AT ALL — MEASURED, NOT ASSUMED, AND ONLY
AFTER THE FIRST VERSION GOT IT WRONG.** The obvious first cut ran the read-back unconditionally,
reasoning that a refused apply creates no rows, so the SELECT would just find none. Driving the
real database suite refused that reasoning directly: `abc27RecipientSnapshot.realpg.test.ts`'s own
operator-wrapper reachability negatives — a malformed subject, a wrong actor, a non-manager peer —
turned a clean, uniform `status: 'refused'` row into a thrown `invalid input syntax for type uuid`
for exactly one of the seven cases. The WRAPPER routine, `rebook_round_apply_command_as_actor`, is
`SECURITY DEFINER` and catches a malformed `auth.uid()` internally (`BEGIN v_actor := auth.uid();
EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;`) before ever reaching its refusal branch — the
CORE it calls, `rebook_round_apply_normalized_core`, takes its actor as a plain `uuid` parameter
and never touches `auth.uid()` at all, so it has no session to be malformed in the first place; an
adversarial review caught an earlier version of this paragraph attributing both routines the same
protection, which was true only of the wrapper. But the read-back is an
ORDINARY, unprivileged `SELECT`, subject to `availability_slots`'s own row-level security, whose
policy evaluates `auth.uid()` again, uncaught. A malformed-subject caller would have received a
JavaScript exception instead of the closed row every other unauthorized caller gets — a NEW,
distinguishing failure mode the wire protocol's own "never zero and never an error: a raise would
itself be an oracle" contract exists specifically not to have. The fix adds no privilege and no
database object: each of the six entrypoints now reads the SEND's own trusted `status` field first
— `wasRefused(result)`, a private, single-purpose predicate — and skips the read-back entirely
when it says `'refused'` — narrowly, that ONE status, not a general "nothing was written" test:
the writing routines answer several OTHER zero-mutation statuses too
(`invalid_request`, `round_not_found`, `expected_version_mismatch`, and more), and neither route to
one reproduces the malformed-session oracle — for two DIFFERENT reasons, which an adversarial review
caught an earlier version of this paragraph collapsing into one false universal. A wrapper-mediated
entrypoint reaches those statuses only past the wrapper's gate, so its read-back runs under an
already-well-formed auth context; a direct-core entrypoint passes no wrapper gate at all, and the
core resolves no session identity to be malformed in the first place. Running the read-back after
one of those statuses is therefore redundant, not unsafe, and this predicate does not need to
recognize them. The certifier's G3-c extension pins the guard's SHAPE exactly: the
verification statement is now `if (!wasRefused(<send>)) { … }` with no `else`, the
condition may read nothing but the send's own local through the one named check, and three more
mutants (an unconditional read-back, a refusal check reading the sealed argument instead of the
send, and a second branch) close the shape as tightly as the four that already covered the
unconditional half.

**Driven, not merely reasoned about.** Both runtime test files gained dedicated groups proving the
mechanism discriminates rather than merely existing: a hand-written client whose read-back reports
a STORED trainer different from what was sent is refused, in the factory; a hand-written client
whose read-back reports a STORED id another identity already claimed is refused, in both the
factory and — driven once per entrypoint, against the full seven-minus-one inventory — the apply
catalogue; and `plantSourceDriftTrigger` refuses outright when the server holds no row at all for
the slot it was asked to drift. The certifier's own G3-c extension is driven the same way G3 always
has been: spliced copies of the real catalogue with the verification skipped, reading the wrong
field, returning a recomputed value, and a colliding local name, each refused by shape.

**A SECOND gap, found by adversarial review rather than this batch's own drive: the claim and the
verification had drifted apart for the three RENDERED entrypoints.** `applyNormalizedCoreShaped`,
`applyNormalizedCoreShapedExtend` and `applyCommandAsActorRenderedBarrier` each take a SECOND
target-bearing field, `targetArray` — a rendered `uuid[]` presentation alongside the bound `targets`
list — and `noteSlotsOwned` already claimed both: `[...(s.targets ?? []), ...uuidsOf(s.targetArray)]`.
But the stored-row verifier that followed it read `s.targets` alone. A slot whose id came from
`targetArray` and nowhere in `targets` was therefore claimed by this identity and never checked
against what the database actually stored for it — the exact property DATABASE_AUTHORITATIVE_RESULT
exists to close, open in three of the six entrypoints this batch had just finished closing it for.
The fix widens all three verify calls to the identical combined expression `noteSlotsOwned` already
used, so the claim and the check name the same set again. **The certifier now enforces this
agreement structurally, not by convention**: `CATALOGUE_TARGET_ARRAY_ENTRYPOINTS` pins which three
entrypoints carry the second field, and G3-c requires `noteSlotsOwned`'s argument and
`verifyStoredSlots`'s second argument to be the SAME recognized shape — `<local>.targets ?? []` for
the three plain entrypoints, the combined spread for these three — refusing either call alone
drifting from the other. Two mutants drive it: the verify call narrowed back to `targets` alone
(the exact regression), and the claim narrowed instead, leaving the verify wider than what was
claimed.

### CERTIFIER_TRUTHFULNESS — one fix, one narrowed claim kept honest, one pin sharpened

**The export walk no longer treats every `constructor` as a back-reference.** `Reflect.ownKeys`
returns OWN properties only, so the language's own INHERITED `constructor` — the one the walk's
prototype-chain bound already keeps out of reach — never appears in this loop at all; only a
genuine own data property spelled `constructor` does, and `{ constructor: { sql: 'SELECT 1' } }`
is exactly that. The special case that skipped its VALUE unread is deleted; a case in
`abc27ApplyCatalogue.runtime.test.ts` drives both directions — an own `constructor` carrying a
statement is now found, and an ordinary object's inherited one still never surfaces as a text this
walk visits.

**G1's octal/hex-escape gap is narrowed by DOCUMENTATION, not by a fail-closed rewrite — measured,
not assumed.** A version of this fix WAS tried: refuse to lex any `E'…'` string carrying a
backslash-digit, `\x`, `\u` or `\U` escape, on the theory that an un-decodable numeric escape
should surface as unreadable rather than be silently mis-decoded. It refused the real repository
outright, because the realpg suite carries legitimate `E'\x…'::bytea` round trips inside literals
that also happen to mention `availability_slots` elsewhere in the same large text, and G1 has no
way to refuse only the write-shaped portion of a literal — refusing the escape refused reviewed
content that names no write at all. That is a worse trade than the residual it would close, so the
code is unchanged and the residual is named instead, in both the module's own header and in
`readEscapeString`'s doc comment: a write whose verb or trainer is spelled through a numeric or
unicode string escape, or through a PL/pgSQL `EXECUTE` argument assembled with `||` outside a
function body this audits, is not decoded here. Both are narrower and more contrived paths past G1
than any ordinary spelling needs, and the runtime ownership check — which reads values, not
spellings — is what actually covers them, exactly as it already covers a routine name assembled
from fragments that never spell it.

**R3's one exemption is now pinned by file and by the exempted statement's own content digest, not
only by count.** A count of one was satisfied by any single exempt write anywhere a marker was
written; moving the marker to a different statement, or to a different file, changed nothing the
old check saw. `EXPECTED_EXEMPTION_DIGEST` is the sha256 of the census control's own rendered text,
computed the moment the exemption is recorded, and the CLI now refuses an exemption count of one
whose file is not the realpg suite or whose digest is not this one — checked against the real
repository directly, and against three mocked cases: the wrong file, the wrong digest, and the
right file-and-digest at an arbitrary line number, which must still pass, because the line is
deliberately not part of the pin — an edit anywhere above the census control in a 30,000-line file
moves its line number for a reason that has nothing to do with the exemption.

**`rehearsalSharding`'s CI-gate-contract control gained a real timeout, not only a stated budget.**
`spawnSync` is fully synchronous: it blocks the whole thread until the child exits, so vitest's own
per-test timeout — a timer on the event loop — cannot fire while the thread it would need to
interrupt is parked inside that blocking call. The `180_000` beside the test was a label a hung
child could not be stopped by. `spawnSync`'s own `timeout` option is what Node's child_process
binding enforces natively, set at `170_000` — below the vitest budget, not at it, so spawnSync's own
kill produces a diagnosable result before the outer timeout, which still cannot preempt a blocked
thread, would otherwise leave the run simply hanging. A second, fast, isolated test proves the
mechanism itself: a deliberately-hung child and a 200 ms timeout are killed with `signal: 'SIGTERM'`
and an `ETIMEDOUT` error in well under a second, so a refactor that silently dropped the `timeout`
option from the real call would still be caught without waiting out 170 real seconds to prove it.

### RECORD_ACCURACY — two more figures derived, two more removed, two claims corrected

The bounded-certifier closure's own record named the lesson: *a guard that covers most of a class
licenses the rest.* Two figures were left hand-maintained because they were not cheaply derivable,
and both drifted within the batch that wrote that sentence — the self-test's own assertion total
(record said 239, actual was 249) and the unit suite's test count (record said 4,100, actual was
4,117). Both are corrected here, and neither is corrected the same way twice.

**The self-test assertion total is now DERIVED.** `selfTest()` gained an optional `onCount`
callback, fired with the final count in both its pass and fail branches, without widening its
public contract — the CLI's `process.exit(selfTest())` is unchanged. The runbook's derived-figure
test now runs the self-test in-process, silenced, and reads its own count back through that
callback, checked against both places the figure is stated (the corpus-description sentence and the
gate table), in an explicit 180-second budget for the same reason the repository-clean test beside
it carries one.

**Superseded (2026-09-04).** The `onCount` callback and the derived-figure test are retired.
The self-test's assertion total is RUNTIME OUTPUT — the summary line the CLI prints — and the
unit test that used to match it against this prose now checks that line against the corpus it
ran, never against a document. The figure stated above is historical.

**The unit suite's test count is REMOVED as a hand-maintained exact figure**, not corrected to a
new one that would drift again by the time this batch's own test additions finish landing. `npx
vitest run --project unit` is its own CI step with its own multi-minute cost; deriving the number
here would mean re-running the whole suite inside a tripwire that does not otherwise need it — the
same reasoning that already keeps the ephemeral mutation total out of this record, applied to a
second figure for the same reason. The gate table states it as MEASURED at the final run, not
derived, and says so.

**The claim that "each number is stated once, in the table" was false when written** — the bounded-
certifier closure's own record said so, and it is corrected here rather than repeated: several
figures are deliberately stated twice, once in a narrative sentence and again in the evidence
table's own row, and the derived-figure guard checks every occurrence against the same corpus
figure, which is what makes a second copy left behind by an edit to the first go red. And the
sentence naming HOW MANY figures are derived is removed rather than corrected a second time: it
said "eleven" when the list had grown to thirteen, which is a hand-maintained count of
hand-maintained counts — the identical mistake one level up. No count is stated; every figure in
the table below is derived, in full, or it says plainly that it is not.

### The evidence, counted

> **Historical snapshot.** The figures in this table are those of the round that wrote it;
> they are not current authority and no test reads them — see the record-authority notice
> above.

| Where | What |
|---|---|
| driver-level coercion controls (factory) | **6 tests** — `toPostgres()` and `Symbol.toPrimitive` and a two-faced `toString`, each refused as a slot id with the hostile method's own call counter left at zero; `toPostgres()` refused as a trainer the same way; a two-faced `get id()` and `get trainer()` on `insertSlot`'s own options, each proved read exactly once |
| stored-row controls (factory) | **3 tests** — a stored trainer that differs from what was sent, a stored id colliding with a slot another identity already claimed, and `plantSourceDriftTrigger` refusing a slot the server holds no row for |
| stored-row controls (apply catalogue) | **3 tests** — a read-back reporting a target id another identity already claimed, driven once directly and once across the full six-entrypoint verifying inventory (compared against the pinned surface minus the one no-slot exception, so a seventh verifying entrypoint cannot arrive unexercised); and a third proving the inverse — a refused apply attempts no read-back at all, driven across that same inventory, catching the RLS permission-oracle regression the second test's own `wasRefused` guard exists to close |
| G1-e factory export-surface controls | **4** — one CLEAN control over the real factory, plus three mutants: the raw `SLOT_STATEMENTS` map re-exported, an unrelated new export, and a pinned entrypoint dropped from the surface |
| G3-c stored-result verification controls | **9** new mutants over the real catalogue: the verification skipped entirely, reading the wrong sealed field, a return that recomputes instead of handing back the send's own result, a send-local colliding with a module binding, the verification running UNCONDITIONALLY with no refusal guard, the refusal check reading the wrong local, the guard carrying an `else` branch, and two more an adversarial review's own P1 finding made necessary — a combined-shape entrypoint's verify call dropping `targetArray` (checking `targets` alone, the exact regression found), and its `noteSlotsOwned` claim narrowed to `targets` alone while the verify stays wide |
| R3 exemption-location controls | **3** — the CLI refuses the one exemption at the wrong file, refuses it at the wrong digest, and accepts it at the pinned file and digest regardless of its line number (deliberately not part of the pin) — each driven through `main`'s own `analyzeFn` seam, plus an end-to-end check that the REAL repository's one exemption is the pinned file and digest |
| `rehearsalSharding` timeout mechanism control | **1 test** — a deliberately-hung child and a 200 ms `spawnSync` timeout are killed with `signal: 'SIGTERM'` and an `ETIMEDOUT` error, proving the mechanism itself rather than only the happy path |
| constructor export-walk control | **2 assertions** in the existing `abc27ApplyCatalogue.runtime.test.ts` completeness test — an own data property literally named `constructor` carrying a statement is now found, and an ordinary object's inherited `constructor` still never surfaces as a text the walk visits |
| self-test assertion total | **262**, DERIVED — up from 253 (the bounded-certifier closure's own last count), counted by running the self-test in-process rather than restated by hand. NO ARITHMETIC BREAKDOWN IS STATED: an earlier version of this row itemized the delta as four G1-e cases plus seven plus two G3-c cases, and an adversarial review's own arithmetic caught that the itemized parts do not sum to the stated total — a hand-computed decomposition of a DERIVED figure is the identical mistake this document already corrected once elsewhere ("eleven" vs "thirteen"), one level up |

### Gates, on the final bytes

> **Historical snapshot.** The figures in this table are those of the round that wrote it;
> they are not current authority and no test reads them — see the record-authority notice
> above.

| Gate | Result |
|---|---|
| `npm run check:trainer-authority` | ✓ 19 guarded WRITE statements in the factory, 1 declared exemption, 7 audited catalogue statements, 7 typed entrypoints, 12 pinned mentions over 12 identities seen, `libpg-query@18.1.4 (PostgreSQL grammar 180004)` |
| `npm run check:trainer-authority:selftest` | ✓ 262 assertions over 123 SYNTHETIC fixtures, plus the real repository checked on its own |
| `eslint .` | ✓ 0 findings, full repository, exit captured directly |
| typecheck (structured baseline, never bare `tsc`) | ✓ 82 pre-existing, baseline 82 — no new type errors. Run under an explicit heap (`NODE_OPTIONS=--max-old-space-size=8192`) for this LOCAL verification only, after confirming a bare run OOMs and silently reports 0 errors on this host — see [[ci-typecheck-false-green]] in the operator's own memory; nothing in this batch's own diff touches the workflow contract that makes this unfixable in CI as it stands |
| `npm run build` | ✓ |
| `npm run check:edge-pins` | ✓ every external import in 281 edge-function files names an exact version |
| unit suite | ✓ 393 files / 4,155 tests, run in full (not derived) |
| `rehearsalSharding.test.ts` | ✓ 39 tests, including the new genuine-timeout-kill control |
| full db suite, real PostgreSQL | three consecutive runs against the round-1/round-2 fixes, ✓ 230/230 each, and a focused pass after each later closure round — one for round 4's re-applied pair and one for round 5's byte-copy replacement and comment narrowing — ✓ 230/230 each. The repeatability protocol was not re-run for those: both later changes are confined to a JS-side object-copy helper and a comment, introducing no database-observable behaviour and no new timing, which is the condition under which the earlier three-run evidence still stands. The specific run figures are reported to the operator rather than written into a fifth place in this document, for the reason the earlier closure batch already found and named: this suite reads this file, so a result recorded here describes a tree that no longer matches what was run the moment it is added — see the earlier "Why no run table lives here" |
| mutation kill, hand-applied on the real modules | ✓ — `capturedId`'s primitive gate relaxed to coerce instead of refuse (killed: 4 driver-level-coercion tests fail with a DIFFERENT, later error, proving the gate itself is load-bearing, not merely present); the STATEMENT-level `wasRefused` guard stripped at all six call sites (killed: the new "does not attempt the read-back" test fails, reproducing the exact RLS-oracle shape this guard exists to close); `applyNormalizedCoreShaped`'s verify call narrowed back to `s.targets ?? []` alone, the exact regression a review found, reintroduced directly on the real file (killed: the certifier itself refuses it by shape, not merely a unit test); `sealed()`'s copy target reverted from `Object.create(null)` to `{}`, reintroducing the `__proto__`-retargeting hole a review found (killed: the prototype-pollution control's getter-call-count assertion goes from 0 to 3); the Buffer branch reverted to a bare `v` pass-through (killed: the disguised-Buffer control's getter-call-count assertion goes from 0 to 5); the same branch reverted to the insufficient `Buffer.from(v)` (killed by the own-`valueOf` control: the hook is invoked once and the wire receives the attacker's 8 mutated bytes in place of the fixture's 5); the same branch reverted to `Buffer.copyBytesFrom(v)`, and separately to `Buffer.from(owned)`, each reintroducing shared-pool aliasing (each killed by exactly ONE sensor, the private-exact-size-backing-store control); the intrinsic typed-array tag conjunct dropped from the gate (killed by exactly TWO sensors and only those — the forged-`DataView` and forged-`Uint16Array` controls); and the `Buffer.isBuffer` conjunct dropped (killed by exactly ONE sensor, the genuine-non-Buffer-view control). The `ArrayBuffer.isView` conjunct was mutated too and SURVIVES, which is recorded rather than hidden: it is logically implied by the tag check, so no control can discriminate it. All of these mutants applied to the real files, run against the real checks, and reverted — confirmed byte-identical afterward by `git status`/`git diff` and a clean re-run |
| mutation, self-test-registered (spliced against the real files, in-process) | ✓ G1-e: 4 cases (1 control + 3 mutants); G3-c: 9 new cases (7 for the `wasRefused` guard, 2 for the combined-shape claim/verify agreement a later adversarial review's P1 finding required) — all counted inside the 262-assertion self-test total above, not double-counted here |
| leftover artifacts | none — no `.bak`/`.orig`/`.tmp` file under `src/test` or `scripts`, no repo file left in a mutated state |

### The round-3 stop

Three fresh adversarial review rounds were budgeted in one thread; three were spent. Round 1 found
the `targetArray` verification gap (now fixed above, and re-confirmed by rounds 2 and 3 without
complaint). Round 2 found the `__proto__` prototype-retargeting gap (now fixed above, and
re-confirmed by round 3 without complaint) plus two wording corrections (applied and also
re-confirmed clean). **Round 3, the final round, found one more of each.** Per the rule quoted in
this section's own STATUS line, neither was left fixed at the time — a separate, explicit
authorization has since granted one exceptional fourth round scoped only to these two findings, and
both are re-applied below exactly as first drafted.

**P1 — a `Buffer` carrying extra own properties survives the seal's Buffer branch unchanged, and
can answer three call sites three different ways.** `sealedValue` (`src/test/abc27ApplyCatalogue.ts`,
the `if (Buffer.isBuffer(v)) return v;` line, currently line 430) returns any `Buffer` UNCHANGED —
reasonable for an opaque `fingerprint` byte string, but a `Buffer` is an ordinary object underneath,
and `Object.defineProperty` can attach extra own properties to one regardless: a `kind`, a `type`,
and a stateful `values` getter — the exact shape of a `RenderedArray` — handed where `targetArray`
is expected. Returning the caller's Buffer unchanged hands back the SAME live object the caller
still holds, so a field this seal never truly copied can still answer the `noteSlotsOwned` claim,
the SQL render, and the `verifyStoredSlots` check three different ways. **Reproduced, not assumed**:
a disguised `Buffer` built exactly this way, handed to `applyNormalizedCoreShaped` as `targetArray`
with no other change, called its own `values` getter 5 times against the unpatched branch (once per
read site, with one extra from the renderer touching it twice), and 0 times after the fix. **NOW
FIXED — and it took three attempts, each defeated by something the previous one had not been asked
about.** `Buffer.from(v)` was the first answer and round 4 showed it insufficient: `Buffer.from`
resolves its overload by CONSULTING THE VALUE, so an own `valueOf()` returning an attacker-held
`ArrayBuffer` selects the zero-copy ArrayBuffer view and the "copy" comes back as a live window onto
memory the caller still owns — measured at 8 attacker bytes in place of the fixture's 5, still
writable afterwards. `Buffer.copyBytesFrom(v)` was the second, and closed that: it reads the
source's internal slots and consults no hook. Round 5 then found what neither had addressed —
**small Buffers are cut from a shared 8 KiB pool**, so a pooled copy and a pooled source occupy one
`ArrayBuffer` at different offsets, and `new Uint8Array(source.buffer).fill()`, reachable from any
caller holding the source, rewrote the sealed bytes after the send (measured: `6162633237` became
`ffffffffff`).

**The branch now takes a dedicated byte snapshot.** `new Uint8Array(v)` allocates its OWN exact-size
backing store rather than drawing from the pool and copies element-wise from internal slots;
`Buffer.from(owned.buffer, owned.byteOffset, owned.byteLength)` then VIEWS that private store, which
is what keeps the result out of the pool — `Buffer.from(owned)` would have gone straight back into
it.

**The gate around it needed a third question, and a review round is why.** `ArrayBuffer.isView` plus
`Buffer.isBuffer` looked sufficient and was not: a `DataView` IS a view, and one given
`Buffer.prototype` satisfies both, after which `new Uint8Array(v)` falls back to the
array-like/iterable path and runs the caller's own `Symbol.iterator` — measured sealing two
caller-chosen bytes. A `Uint16Array` wearing the same prototype passes both as well and is copied
ELEMENT-wise, so four source bytes arrived as two. The gate now also asks the intrinsic
`%TypedArray%.prototype[Symbol.toStringTag]` getter, captured at module load, which answers from an
internal slot: `'Uint8Array'` for a genuine byte view, the family name for a `Uint16Array`,
`undefined` for a `DataView`, a bare prototype object or a `Proxy` — and a `Proxy` answers without a
single trap running. `Buffer.isBuffer` remains the last conjunct because a plain `Uint8Array` also
answers `'Uint8Array'` and must keep falling through to the object branch. `ArrayBuffer.isView` is
kept first as specified but is REDUNDANT given the tag check, and the record says so: no control
discriminates it, and deleting it leaves the suite green.

A refusal uses FIXED text that never formats or interpolates the value, since Node's own
invalid-argument formatter reads a rejected value's `constructor` while describing it (measured at
three reads). The earlier claim that the rejection "called nothing" is not restated, and the narrower
replacement is bounded on purpose: for a genuine byte view nothing on this path reads a property or
invokes a hook, but deciding that a value CLAIMS to be a Buffer means consulting its prototype chain,
and a `Proxy` can trap that — measured, one trap through `Buffer.isBuffer`. That residual is named.
All of this concerns INPUT COERCION only; it says nothing about database or registry effects, which
the guards before the send and the read-back after it are what cover.

The controls in `abc27ApplyCatalogue.runtime.test.ts` are the disguised-`Buffer` test above, an
own-`valueOf` test, an own-`Symbol.toPrimitive` boundary control named as non-discriminating, one
proving the sealed value sits on a private exact-size backing store AND survives a rewrite of the
source's whole backing buffer, and three forgery controls — a bare prototype object, a `DataView`
and a `Uint16Array` — plus one proving a genuine non-Buffer view is still not sealed as a Buffer.
The structural half of the independence control is deliberately the primary assertion: a review
round observed that mutating the source's pool only catches a pooled copy when both land in the SAME
pool `ArrayBuffer`, which a rollover can defeat, whereas an exact-size private backing store is
directly observable. Pooling itself is a property of SMALL allocations — a zero-length buffer and one
larger than the pool do not draw from it — so the claim is about the small case the fixtures use.

**P2 — the comment above `wasRefused` still attributes the wrapper's own protection to "both
writing routines".** The opening of that comment block (`src/test/abc27ApplyCatalogue.ts`, starting
"`'refused'` is the ONE status both writing routines return…", currently line 460) and one sentence
inside the "MEASURED, NOT ASSUMED" paragraph beneath it ("unlike the writing routines, which are
`SECURITY DEFINER` and catch a malformed `auth.uid()` internally…", currently line 470) both say
this of BOTH writing routines. It is true only of the WRAPPER, `rebook_round_apply_command_as_actor`
— the CORE, `rebook_round_apply_normalized_core`, takes its actor as a plain `uuid` parameter, never
calls `auth.uid()` anywhere in its body (confirmed by reading the migration, not assumed), and never
returns the literal string `'refused'` at all. The "A NAMED RESIDUAL" paragraph three paragraphs
below already says this correctly — round 3 is pointing at an internal contradiction WITHIN the
same comment block, not a fact that was never written down. This document's own matching passage
(the paragraph beginning "for exactly one of the seven cases", in "### DATABASE_AUTHORITATIVE_RESULT"
above) carries the identical claim and needs the identical correction. **NOW FIXED, in two steps.**
The first pass attributed the wrapper's protection to the wrapper alone and described the core
precisely — a plain `uuid` actor parameter, no `auth.uid()` call anywhere in its body, no literal
`'refused'` return. Round 4 then found what that pass had left standing one paragraph further down:
a UNIVERSAL sentence claiming every OTHER zero-mutation status is reached "only once the wrapper's
own auth gate has already resolved a real, authorized actor" — true of the wrapper-mediated
entrypoints and false of the three that call the core directly, which pass no wrapper gate at all.
Both the comment and this document now split the claim in two rather than restating it wider: a
wrapper-mediated entrypoint reaches those statuses past the gate, so its read-back runs under an
already well-formed context; a direct-core entrypoint resolves no session identity in the first
place. Neither reproduces the failure mode, for two different reasons, and neither sentence now
implies the other route's premise.

### The rounds after the third, and the batch that closed them

Round 4 was a single exceptional round authorized to confirm the round-3 pair on exact final bytes.
It returned NOT CLEAR — the `Buffer.from` coercion escape and a residual universal claim — and,
under the same rule that governed round 3, neither was fixed at the time. A further authorization
scoped exactly those two for closure and granted a fifth review, which closed the universal claim
but returned NOT CLEAR again on the copy: `Buffer.copyBytesFrom` had left the shared-pool aliasing
above untouched, and the fixed comment's "called nothing" claim did not survive contact with Node's
own error formatter.

Those two findings were then given their own bounded closure batch rather than a sixth round of the
broad audit, and that batch is what the byte-snapshot primitive above, its five controls and the
corrected prose belong to. Its mutation evidence is three targeted mutants, each killed by exactly
ONE named sensor with no overlap between them, each restored byte-exact by sha256: restoring
`Buffer.copyBytesFrom(v)` and, separately, using `Buffer.from(owned)` instead of the owned-buffer
view each fail ONLY the whole-backing-buffer independence control, which is what shows the pool is
the thing the snapshot removes; removing the `ArrayBuffer.isView` gate fails ONLY the
prototype-forgery control. **No review outcome is written back into this document**; it is reported
to the operator, for the same reason the run table is not kept here.

## CURRENT — the canonical hex boundary and record authority (2026-09-04)

**STATUS: local only. Nothing is committed, pushed, merged, deployed or applied; no migration,
role, grant, schema or product runtime is touched. Terminal results and hashes are reported in
the external terminal report, not written here.** This section states invariants, commands and
pass criteria only. It carries no evidence total — no fixture, assertion, test, control or
mutant count: such a cardinality lives in an executable set-equality assertion or in a gate's
own runtime output, and nowhere in this document. The structural facts it names — which
entrypoints exist, that one adapter exists — are pinned by NAME in the code, not counted here.

### The invariants

- **The fingerprint boundary is a primitive string of canonical hex.** `canonicalByteaHex` in
  `src/test/abc27ApplyCatalogue.ts` accepts a value only if `typeof value === 'string'` and
  the string matches lower-case hex in whole byte pairs; the empty string is an empty `bytea`
  and is accepted. Binary argument shapes — a `Buffer`, typed array, `DataView`, `ArrayBuffer`
  or `SharedArrayBuffer` — are refused first by the seal's internal-slot branch, before a byte
  or property of that binary shape is read. An ordinary object takes the ordinary sealing path:
  its own enumerable property values are read once, so an ordinary object accessor **can run
  during sealing**; the sealed plain object is then refused by `canonicalByteaHex`'s `typeof`
  branch, as are `undefined` and every other non-string. No refusal message formats the rejected
  value. Case is not folded and an odd digit count is not padded: a value that is not already
  canonical is refused, not repaired. The length is not pinned — the 32-byte product rule lives
  in the database, which stays its authority.
- **The database boundary is `pg_catalog.decode(…, 'hex')`, everywhere.** A bound fingerprint
  travels as the validated string and the statement decodes it —
  `pg_catalog.decode($n::text,'hex')`; a rendered one is `pg_catalog.decode('<hex>','hex')`
  from `byteaHexLiteral`, over the validated hex itself. No statement carries a backslash
  `bytea` literal, so the bytes do not depend on `standard_conforming_strings`. The refusal
  probe names no client fingerprint at all; it mints one on the server with
  `pg_catalog.sha256`.
- **A byte view is converted in one place, for what the driver hands back — and an argument
  that is one is refused unread.** The argument seal refuses any `ArrayBuffer`,
  `SharedArrayBuffer`, typed array, `DataView` or `Buffer` by internal-slot check before reading
  a byte or a property of it, so no byte view is read anywhere but the adapter.
  `canonicalByteaHexFromBytes` converts a `bytea` column value into the boundary's currency
  and asks internal-slot questions only: `isUint8Array` for the view, the captured
  `%TypedArray%.prototype.buffer` getter for its backing store, `isArrayBuffer` (so shared
  memory is refused), the captured `detached` and `resizable` getters (so a detached or
  resizable store is refused), and then the `Buffer.prototype.toString` intrinsic captured at
  module load, applied with `.call` to the view — no copy, no instance method, no iterator, no
  `Buffer.from`, no `Buffer.copyBytesFrom`, no pool, no `instanceof`, no `ArrayBuffer.isView`,
  no prototype or `Symbol.toStringTag` test. Its result is a primitive, so the source cannot
  change it afterwards. A caller that holds a byte view coerces explicitly through this
  adapter; the argument seal never converts on a caller's behalf.
- **Every call path crosses the boundary by name.** Five fingerprint statements bind the
  validated string: `applyNormalizedCore`, `applyCommandAsActorReceiptPrivacy`,
  `applyNormalizedCoreShaped`, `applyNormalizedCoreShapedExtend` and
  `applyCommandAsActorReachability`. `applyCommandAsActorRenderedBarrier` is the one fingerprint
  statement that renders: its statement helper reaches `canonicalByteaHex` through
  `byteaHexLiteral`. `applyCommandAsActorRefusalProbe` has no client fingerprint and does neither.
  Together those named paths are the pinned `APPLY_ENTRYPOINTS` surface. The realpg suite reaches
  the fingerprint-bearing paths through one adapter, `fingerprintHexOf`, which passes a string
  through untouched and converts a driver byte view through `canonicalByteaHexFromBytes`. The
  catalogue query arguments, rendered helper route, adapter body, and every realpg first-argument
  expression and resolved local reference are pinned from TypeScript syntax trees.
- **No test reads this document for a figure.** The corpus split is an executable equality in
  `src/test/abc27TrainerSourceAuthority.test.ts`; both figures on the ONE summary line
  `check:trainer-authority:selftest` prints — the assertion total and the fixture count — are
  held to exact expectations computed from the corpus, by running that CLI as a child process.
  `selfTest()` takes no count callback. The ABC-27 focused realpg reader extracts the operator SQL
  fences it executes and checks exact installation-window wording. Its retired census/resolution
  absence checks specifically police fenced `IS DISTINCT FROM`, the retired one-hop
  prepared-transaction/lock association, copyable GID-variable assignment forms, unquoted
  GID-variable interpolation, and instructions to hand-transcribe a GID as a SQL literal; it does not make every
  unrelated insertion an ABC-27 focused obligation. The separate D7 prohibited-recall wording
  control is selected with the focused `d7ForwardChain` command listed below.

### The commands, and what passing means

| Command | Passes when |
|---|---|
| `npm run check:trainer-authority` | exit 0, and its output names the parser (`libpg-query@…`) and its PostgreSQL grammar |
| `npm run check:trainer-authority:selftest` | exit 0, and the summary line reads `✅ … assertions over … synthetic fixtures, plus the real repository checked on its own.` |
| `npx vitest run --project unit src/test/abc27ApplyCatalogue.runtime.test.ts src/test/abc27TrainerSourceAuthority.test.ts src/test/abc27SlotFixtures.runtime.test.ts` | every test passes; none is skipped |
| `npx vitest run --project db src/test/abc27RecipientSnapshot.realpg.test.ts` | every test passes against the embedded PostgreSQL, including the `standard_conforming_strings` control over the renderer's own output |
| `npx vitest run --project db src/test/d7ForwardChain.realpg.test.ts -t 'THE RESIDUAL, STATED HONESTLY: the observation-to-commit interval, and nothing wider'` | the runbook and migration state the linearization point, say outright that an authorized send cannot be taken back, and carry no affirmative recall, retraction, unsend or cancellation claim |
| `npx eslint .` | no findings |
| `npm run typecheck:baseline` | no new type errors against the committed baseline |
| `npm run build` | exit 0 |

A mutation battery against this boundary is ephemeral and its result is reported to the
operator; it is not recorded here, for the reason "Why no run table lives here" already gives.

### The whole-source authorities (2026-09-04, closure of the terminal review)

The function-local source pins the terminal review found non-total are retired in favour of
whole-source authorities. Each is fail-closed, and each is a literal pin written down from the
reviewed bytes — never computed, normalised or updated from the bytes it judges. Every pinned
byte sequence is read by `vi.hoisted`, before any import of the reading test file executes, so a
digest is over its subject as it was on disk before that subject or any other imported module ran.

- **The catalogue module is pinned whole.** `src/test/abc27ApplyCatalogue.runtime.test.ts`
  holds the literal SHA-256 of the complete raw bytes of `src/test/abc27ApplyCatalogue.ts`, the
  complete top-level declaration and import/export surface as one closed list, and a
  TypeScript-Program census in which every identifier the module reads resolves to a module
  const, an import, a parameter, a local, a type parameter, a module type or interface, or one
  of a listed set of unshadowed globals. A module-local shadow of `Buffer`, `Array`,
  `Object`, `Reflect`, `Uint8Array`, `ArrayBuffer` or of a captured intrinsic fails the digest
  and the surface list, and a shadow of a name the module reads also fails the census. That one
  authority covers `sealed`, `sealedElement`, `LOWER_HEX`, every capture initializer and all
  executable module code; the runtime and adversarial controls around it are kept, and the
  function-local shape pins it supersedes are retired.
- **The realpg suite and the checker are pinned whole, and their readings sit inside those
  pins.** `src/test/abc27TrainerSourceAuthority.test.ts` holds the literal SHA-256 of the
  complete raw bytes of `src/test/abc27RecipientSnapshot.realpg.test.ts` and of
  `scripts/check-abc27-trainer-source-authority.mjs`. Within the pinned suite it finds each
  direct call of a catalogue entrypoint by its resolved import symbol, requires the imported
  value surface and the direct-invocation set to be equal in both directions, refuses any other
  reference to an entrypoint, pins the complete text of each call and its argument object keyed
  by the enclosing declaration and test rather than by line, refuses spread, computed, method,
  accessor and duplicate keys and any shorthand `fingerprintHex` (a shorthand for another key
  is admitted only as a resolved, explicit, non-computed key and is listed in the pin), requires
  `fingerprintHex` exactly once where the entrypoint takes one with an initializer that
  resolves to the single module-level `fingerprintHexOf`, and pins that adapter as one complete
  declaration whose conversion resolves to the catalogue import. Within the pinned checker it
  locates exactly one module-level declaration each of `analyzeFixtures` and `selfTest` and
  holds the literal SHA-256 of each complete declaration's source slice. The whole-file pins are
  what hold a module acquired by any route other than the static import, and a live binding
  reassigned after its pinned declaration; the call catalogue and the slice pins are readings,
  not authorities over them. The behavioural collision control drives several distinct collision
  counts as a sample and is not the authority.

**Change discipline.** Version control plus these exact whole-source pins are the change
authority. A legitimate change to a pinned subject is made deliberately: edit the subject,
replace the literal digest in the named test with the digest of the reviewed bytes, and obtain a
fresh deep review of the change. No control derives, normalises or updates a digest from the
bytes it judges, and no further certifier is layered over these authorities.
