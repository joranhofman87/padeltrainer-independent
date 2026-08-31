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
