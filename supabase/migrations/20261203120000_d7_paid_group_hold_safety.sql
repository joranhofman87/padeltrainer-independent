-- D7 RUNTIME — PAID-GROUP COURT-HOLD SAFETY, PRESERVED FOR EVERY PAYMENT MODE.
--
-- OWNER DECISION (D/RP-3/L-7). An invitation must NEVER offer a freed seat on a court that a PAID
-- rebook group already holds, whatever the round's `rebook_payment_mode` is.
--
-- WHAT WAS WRONG, AND IT WAS REACHABLE. ABC-27's live-eligibility authority carried ONE paid-group
-- rule and it was CYCLE-level: `rebook_payment_mode <> 'upfront'`. The predicate it replaced —
-- `slot_held_by_paid_group` (20260817100000) — was SLOT-level: a priority claim carrying a
-- `rebook_group_id` for which a `paid` invoice exists. Those are not the same shape, and the gap
-- between them is reachable through the product:
--
--   1. BOTH create paths stamp a `rebook_group_id` on EVERY claim, one per child series, with no
--      reference to the payment mode — `bulk-rebook-cycle` and ABC-27's own
--      `abc27_p_normalized_apply_create`.
--   2. `create-rebook-invoice-public` DELEGATES a SOLO group (a one-player series, or a group that
--      attrited to one) to `create-group-rebook-invoice`. Neither function reads
--      `rebook_payment_mode` at all.
--   3. That tags `invoices.rebook_group_id`; once the invoice is paid the slot-level predicate is
--      satisfied — on a `deferred_split` round.
--   4. The legacy blast excluded that court's freed seats. The cycle-level rule does not fire, so
--      the invitation went out for seats on a court somebody had already paid for in full.
--
-- WHAT THIS FILE DOES. It replaces exactly ONE function body — the live-eligibility authority — to
-- fold the canonical SLOT-LEVEL hold into arm (4), the freed-seat existence test. The cycle-wide
-- `upfront` suppression in arm (5) is RETAINED unchanged: an upfront round is paid in full at claim
-- time whether or not a group invoice exists, so it is suppressed for a different and still-valid
-- reason. Payment mode is never used as a proxy for a paid-group hold, and no cycle-wide
-- suppression is added where the canonical authority is per-slot.
--
-- WHAT IT DOES NOT DO. No new relation, column, index, trigger, role, RLS policy, grant, runtime
-- API or permission widening. No schedule is armed. Not one byte of the frozen ABC-27 migration
-- changes. The function keeps its exact signature, owner, ACL, volatility, SECURITY DEFINER flag,
-- `search_path`, error semantics and tenant non-disclosure — every one of which is captured before
-- the replacement and re-compared after it, in the same transaction, so a drift is a migration
-- failure rather than a discovery.
--
-- ── THE PREREQUISITE GUARD ───────────────────────────────────────────────────────────────────
--
-- This file sorts AFTER ABC-27, and the frozen ABC-27 evidence suite builds its predecessor from
-- the migrations directory MINUS the file under test — which sweeps this file in and replays it
-- BEFORE ABC-27, an order production never sees. The function it replaces does not exist there, so
-- the block refuses to act. A skipping migration is a FAIL-OPEN, and it is paid for:
-- `src/test/d7ForwardChain.realpg.test.ts` replays the directory in TRUE filename order and
-- asserts the replacement actually happened — i.e. that this guard never fires on the real chain.
--
-- ── HOW THE REPLACEMENT IS LEGAL ─────────────────────────────────────────────────────────────
--
-- `abc27_p_live_eligibility` is owned by the DOMAIN-P owner, which ABC-27 resolves as the owner of
-- `public.cycles` rather than by hardcoding a name (a hardcoded name would be wrong on some install
-- or would quietly "fix" the drift the assertion exists to catch). This file resolves it the same
-- way, refuses if the function is not owned by it, refuses if the applying role may not act as it,
-- and then performs the replacement AS that role. `CREATE OR REPLACE FUNCTION` preserves the OID,
-- the owner and the ACL by construction; the post-checks prove it did.

DO $d7_paid_group_hold$
DECLARE
  v_ident   CONSTANT text := 'public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])';
  -- THE ROLE THIS BLOCK WAS ENTERED WITH, so it can be restored exactly. `RESET ROLE` returns to
  -- `session_user`, which is NOT necessarily the role that entered: a privileged login that had
  -- already done `SET ROLE restricted_migrator` would be silently ELEVATED for the rest of the
  -- migration run by a `RESET`. Capturing and restoring the entry role cannot do that.
  v_entry   CONSTANT name := current_user;
  v_p       name;
  v_oid     oid;
  b_oid     oid;
  b_owner   name;
  b_acl     text;
  b_secdef  boolean;
  b_vol     "char";
  b_config  text;
  b_args    text;
  b_src     text;
  a_owner   name;
  a_acl     text;
  a_secdef  boolean;
  a_vol     "char";
  a_config  text;
  a_args    text;
  a_src     text;
BEGIN
  -- `pg_catalog`, NOT `information_schema`. The information_schema views are PRIVILEGE-FILTERED:
  -- they show a column only to a role that owns the relation or holds a privilege on it. A
  -- deployment role able to assume the Domain-P owner but holding nothing on the Domain-N
  -- `notification_outbox` would see the column as ABSENT, take this skip, and let the migration be
  -- recorded as applied over nothing. `pg_attribute` is not filtered, so the guard now answers the
  -- question it is actually asking: does the object exist, not may I see it.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27 and must never run before it)';
    RETURN;
  END IF;

  -- THE EXACT REVIEWED IDENTITY MUST ALREADY EXIST. A same-named function at another signature is
  -- not the authority this file is authorised to replace, and creating one would ADD a surface.
  v_oid := to_regprocedure(v_ident);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'D7 paid-group hold: % is absent — this file replaces an existing authority, it does not create one', v_ident;
  END IF;

  SELECT p.oid, p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO b_oid, b_owner, b_acl, b_secdef, b_vol, b_config, b_args, b_src
    FROM pg_proc p WHERE p.oid = v_oid;

  -- THE LEGAL PRODUCT OWNER, RESOLVED THE WAY ABC-27 RESOLVES IT — never hardcoded.
  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'cycles';
  IF v_p IS NULL THEN
    RAISE EXCEPTION 'D7 paid-group hold: cannot resolve the Domain-P owner — public.cycles is missing';
  END IF;
  IF b_owner IS DISTINCT FROM v_p THEN
    RAISE EXCEPTION 'D7 paid-group hold: % is owned by % but the Domain-P owner is % — refusing to replace an authority this file does not understand',
      v_ident, b_owner, v_p;
  END IF;
  -- FAIL CLOSED IF THE APPLYING ROLE MAY NOT ACT AS THE OWNER. Without this the replacement would
  -- fail deep inside with a bare "must be owner", after the capture above had already run.
  --
  -- MEMBERSHIP IS THE PORTABLE PRE-CHECK, NOT THE AUTHORITY. `pg_has_role(..., 'USAGE')` tests
  -- INHERITANCE, which is not the same capability as `SET ROLE`: since PostgreSQL 16 a membership
  -- can carry `SET` without `INHERIT` and vice versa, so a USAGE test both rejects a role that
  -- could set and admits one that cannot. `MEMBER` is the version-portable membership question, and
  -- the real gate is the `SET LOCAL ROLE` itself — attempted below, with its failure re-raised as a
  -- message that says what to do instead of a bare permission error.
  IF NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 paid-group hold: % is not a member of the Domain-P owner % — apply this migration as a role that is',
      current_user, v_p;
  END IF;

  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', v_p);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'D7 paid-group hold: % may not SET ROLE to the Domain-P owner % (%) — grant it the SET option or apply as that role',
      v_entry, v_p, SQLERRM;
  END;

  CREATE OR REPLACE FUNCTION public.abc27_p_live_eligibility(
    p_academy   uuid,
    p_round     uuid,
    p_recipient uuid[],
    p_cycle     uuid[],
    p_key       text[],
    p_claim     uuid[]
  ) RETURNS TABLE (rebook_round_recipient_id uuid, source_cycle_id uuid, ok boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE
    -- `cardinality()`, NOT `array_length(x, 1)`. PostgreSQL's `uuid[]`/`text[]` accept
    -- MULTIDIMENSIONAL values, `array_length(x, 1)` reports only the FIRST dimension, and `unnest`
    -- flattens every element regardless of shape. A caller passing four 2×5000 arrays would show
    -- `array_length = 2`, satisfy a first-dimension equality check, slip under a first-dimension
    -- bound, and then scan 10,000 candidates. `cardinality()` counts the flattened elements — the
    -- same population `unnest` actually produces — so the check and the scan agree by construction.
    -- `cardinality(NULL::uuid[])` is NULL, and every comparison against NULL is NULL — which an IF
    -- treats as false, so a NULL array would slip past both the ragged check and the bound. Each
    -- count is therefore normalized to 0 first; a NULL array is exactly an empty candidate set.
    v_len int := coalesce(cardinality(p_recipient), 0);
  BEGIN
    IF p_academy IS NULL OR p_round IS NULL THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: academy and round are required' USING ERRCODE = '42501';
    END IF;
    -- ONE DIMENSION ONLY, AND ONLY WHEN THERE IS ANYTHING TO SHAPE. Cardinality equality already
    -- stops a short array being zipped against a long one, so this rule is not about padding — it
    -- is about keeping the DECLARED contract one-dimensional, so a caller cannot hand over a 2×N
    -- value whose transposition is meaningful to it and merely positional here.
    --
    -- THE EMPTY CASE IS NOT A SHAPE VIOLATION. PostgreSQL represents a non-NULL empty array as
    -- DIMENSIONLESS: `array_ndims('{}'::uuid[])` is 0, not 1. A blanket `<> 1` therefore rejects the
    -- perfectly ordinary empty candidate set that `ARRAY(SELECT ... FROM triples)` produces whenever
    -- a round has no provenance rows yet — and it would also have made NULL and `{}` behave
    -- differently, when both mean "no candidates". Each array is shape-checked only when it actually
    -- carries elements.
    IF (coalesce(cardinality(p_recipient), 0) > 0 AND array_ndims(p_recipient) <> 1)
       OR (coalesce(cardinality(p_cycle), 0) > 0 AND array_ndims(p_cycle) <> 1)
       OR (coalesce(cardinality(p_key), 0)   > 0 AND array_ndims(p_key)   <> 1)
       OR (coalesce(cardinality(p_claim), 0) > 0 AND array_ndims(p_claim) <> 1) THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: candidate arrays must be one-dimensional (got %, %, %, % dimensions)',
        coalesce(array_ndims(p_recipient), 0), coalesce(array_ndims(p_cycle), 0),
        coalesce(array_ndims(p_key), 0), coalesce(array_ndims(p_claim), 0) USING ERRCODE = '22023';
    END IF;
    -- The four arrays are ONE relation transposed. Ragged input would silently pair a recipient
    -- with another recipient's claim, so it is refused rather than zipped to the shortest.
    IF coalesce(cardinality(p_cycle), 0) <> v_len
       OR coalesce(cardinality(p_key), 0) <> v_len
       OR coalesce(cardinality(p_claim), 0) <> v_len THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: the candidate arrays are ragged (% recipients, % cycles, % keys, % claims)',
        v_len, coalesce(cardinality(p_cycle), 0), coalesce(cardinality(p_key), 0),
        coalesce(cardinality(p_claim), 0) USING ERRCODE = '22023';
    END IF;
    -- The SAME definition the freeze enforces at capture time (Stage 7.4-A review): two spellings
    -- of this ceiling were exactly the drift that could freeze a universe this check then refuses
    -- forever. The A-owned function carries a counterpart_p grant for this one consultation.
    IF v_len > public.rebook_round_max_claim_sources() THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: % candidate provenance rows exceeds the approved % per round',
        v_len, public.rebook_round_max_claim_sources()
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH triples AS (
      SELECT DISTINCT t.recipient, t.cycle, t.key, t.claim
        FROM unnest(p_recipient, p_cycle, p_key, p_claim) AS t(recipient, cycle, key, claim)
       WHERE t.recipient IS NOT NULL AND t.cycle IS NOT NULL AND t.key IS NOT NULL
    ),
    -- TENANT AND ROUND RE-DERIVED BY P. This join is the containment: it is an INNER join, so an
    -- unowned or unattached cycle drops the pair entirely.
    scoped AS (
      SELECT tr.recipient, tr.cycle, tr.key, tr.claim, c.status AS cycle_status, c.settings AS cycle_settings
        FROM triples tr
        JOIN public.cycles c
          ON c.id = tr.cycle
         AND c.owner_type = 'academy'
         AND c.owner_id = p_academy
         AND c.rebook_round_id = p_round
    ),
    pairs AS (
      SELECT DISTINCT s.recipient, s.cycle, s.key, s.cycle_status, s.cycle_settings FROM scoped s
    )
    SELECT p.recipient, p.cycle,
      (
        -- (1) an OUTSTANDING provenance-linked claim whose CURRENT identity is still this person.
        --     Outstanding is the owner-ruled two-value vocabulary (pending, expired) — see the
        --     eligibility authority's comment for why `expired` is included and `released` is not.
        --     The claim identities are the ones Domain A's immutable provenance named; P proves they
        --     still exist, still sit on a slot of THIS cycle, and still canonicalize to this key.
        EXISTS (
          SELECT 1
            FROM scoped sc
            JOIN public.slot_priority_claims spc ON spc.id = sc.claim
            JOIN public.availability_slots s     ON s.id = spc.slot_id
           WHERE sc.recipient = p.recipient
             AND sc.cycle = p.cycle
             AND s.source_cycle_id = p.cycle
             AND spc.status IN ('pending','expired')
             AND public.rebook_round_recipient_key(spc.guest_player_id, spc.player_id) = p.key
        )
        -- (2) no seat ALREADY claimed here — they have one, so there is nothing to invite them to.
        AND NOT EXISTS (
          SELECT 1 FROM public.slot_priority_claims spc
            JOIN public.availability_slots s ON s.id = spc.slot_id
           WHERE s.source_cycle_id = p.cycle
             AND spc.status = 'claimed'
             AND public.rebook_round_recipient_key(spc.guest_player_id, spc.player_id) = p.key
        )
        -- (3) no explicit DECLINE here — they said no to this sibling.
        AND NOT EXISTS (
          SELECT 1 FROM public.slot_priority_claims spc
            JOIN public.availability_slots s ON s.id = spc.slot_id
           WHERE s.source_cycle_id = p.cycle
             AND (spc.status = 'declined' OR spc.response_intent = 'decline')
             AND public.rebook_round_recipient_key(spc.guest_player_id, spc.player_id) = p.key
        )
        -- (4) this sibling has a genuinely free seat. Canonical rules, copied from the detection RPC
        --     that shipped (20260714110000): a booking occupies a seat when it is confirmed, pending
        --     or pending_approval, or payment_pending with a hold that has not expired. This is the
        --     retired `rebook_sibling_has_free_seat`, folded in so there is ONE product reader.
        AND EXISTS (
          SELECT 1 FROM public.availability_slots s
           WHERE s.source_cycle_id = p.cycle
             -- (4a) …AND THE COURT IS NOT ONE A PAID REBOOK GROUP ALREADY HOLDS.
             --
             -- Derived from the canonical slot-level authority `slot_held_by_paid_group`
             -- (20260817100000), predicate-for-predicate, with `_slot_id` bound to this slot. It is
             -- INLINED rather than called because calling it would need an EXECUTE grant to the
             -- Domain-P owner, and this closure adds no grant; parity with the canonical authority is
             -- therefore proved behaviourally, slot for slot, rather than asserted.
             --
             -- IT SITS INSIDE ARM (4), NOT BESIDE ARM (5), AND THAT IS THE WHOLE POINT. The paid-group
             -- hold is a fact about ONE COURT: a group that paid for its court in full holds that
             -- court's seats against outsiders, and says nothing about the sibling's other slots. So
             -- it disqualifies THIS slot from being the free seat, and a genuinely free seat on any
             -- other slot of the same sibling still makes the recipient eligible. Expressing it as a
             -- cycle-wide arm would over-suppress every other court in the sibling, which is the
             -- mirror image of the defect this closure repairs.
             --
             -- NO STATUS FILTER ON THE CLAIM, and no tenant filter on the invoice — both deliberate,
             -- both copied. Even an EMPTY paid group keeps its court (20260817100000's own words), and
             -- the group id is a random UUID minted per series, so an invoice can only match a claim
             -- of the same group. Adding a tenant predicate here would be a SECOND, divergent
             -- spelling of an authority whose whole value is that there is one.
             AND NOT EXISTS (
               SELECT 1
                 FROM public.slot_priority_claims hspc
                 JOIN public.invoices hi ON hi.rebook_group_id = hspc.rebook_group_id
                WHERE hspc.slot_id = s.id
                  AND hspc.rebook_group_id IS NOT NULL
                  AND hi.status = 'paid'
             )
             AND (
               SELECT count(*) FROM public.bookings b
                WHERE b.slot_id = s.id
                  AND (
                    COALESCE(b.status, 'confirmed') IN ('confirmed','pending','pending_approval')
                    OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
                  )
             ) < COALESCE(s.max_participants, 1)
        )
        -- (4b) THE SIBLING IS STILL OPEN, RE-READ NOW. The freeze proved every sibling was `open` at
        --      freeze time (§8 step 3), but the freeze and the send are separated by the whole member
        --      window. Read from the SAME row the tenant anchor above matched, so the open-ness and
        --      the ownership are one observation rather than two.
        AND p.cycle_status = 'open'
        -- (5) NOT an excluded upfront/paid group: an upfront round is paid in full at claim time, so
        --     "a seat freed up, come and take it" is not an instrument the product can honour.
        AND COALESCE(p.cycle_settings->>'rebook_payment_mode', '') <> 'upfront'
      ) AS ok
      FROM pairs p;
  END;
  $$;

  -- BACK TO THE ROLE THIS BLOCK WAS ENTERED WITH — not `RESET ROLE`. See `v_entry` above.
  EXECUTE format('SET LOCAL ROLE %I', v_entry);

  -- ── NOTHING BUT THE BODY MOVED ─────────────────────────────────────────────────────────────
  --
  -- `CREATE OR REPLACE FUNCTION` preserves the OID, the owner and the ACL by construction, and
  -- restates volatility, SECURITY DEFINER and `search_path` from the text above. Every one of them
  -- is re-read and compared rather than trusted, because "it preserves them" is a claim about
  -- PostgreSQL and the text, and the text is what this file changes.
  SELECT p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO a_owner, a_acl, a_secdef, a_vol, a_config, a_args, a_src
    FROM pg_proc p WHERE p.oid = to_regprocedure(v_ident);

  IF to_regprocedure(v_ident) IS DISTINCT FROM b_oid THEN
    RAISE EXCEPTION 'D7 paid-group hold: the function identity moved — a replacement must not create a second object';
  END IF;
  IF a_owner IS DISTINCT FROM b_owner THEN
    RAISE EXCEPTION 'D7 paid-group hold: owner changed from % to %', b_owner, a_owner;
  END IF;
  IF a_acl IS DISTINCT FROM b_acl THEN
    RAISE EXCEPTION 'D7 paid-group hold: the ACL changed from % to % — this file widens no privilege', b_acl, a_acl;
  END IF;
  IF a_secdef IS DISTINCT FROM b_secdef THEN
    RAISE EXCEPTION 'D7 paid-group hold: SECURITY DEFINER changed';
  END IF;
  IF a_vol IS DISTINCT FROM b_vol THEN
    RAISE EXCEPTION 'D7 paid-group hold: volatility changed from % to %', b_vol, a_vol;
  END IF;
  IF a_config IS DISTINCT FROM b_config THEN
    RAISE EXCEPTION 'D7 paid-group hold: the settings (search_path) changed from % to %', b_config, a_config;
  END IF;
  IF a_args IS DISTINCT FROM b_args THEN
    RAISE EXCEPTION 'D7 paid-group hold: the signature changed from (%) to (%)', b_args, a_args;
  END IF;

  -- ── AND THE BODY DID CHANGE ────────────────────────────────────────────────────────────────
  --
  -- Without this a copy-paste that re-installed the ORIGINAL body would pass every check above and
  -- ship a migration that repairs nothing while reporting itself applied.
  IF a_src = b_src THEN
    RAISE EXCEPTION 'D7 paid-group hold: the body is unchanged — the replacement was a no-op';
  END IF;
  -- …and it changed in the ONE way this file is for: the slot-level hold is present, and the
  -- cycle-wide upfront suppression is still there beside it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure(v_ident)
       AND p.prosrc LIKE '%hi.rebook_group_id = hspc.rebook_group_id%'
       AND p.prosrc LIKE '%hi.status = ''paid''%'
  ) THEN
    RAISE EXCEPTION 'D7 paid-group hold: the installed body does not carry the slot-level paid-group hold';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure(v_ident)
       AND p.prosrc LIKE '%rebook_payment_mode%'
  ) THEN
    RAISE EXCEPTION 'D7 paid-group hold: the cycle-wide upfront suppression was lost — it is RETAINED, not replaced';
  END IF;

  RAISE NOTICE 'D7: the slot-level paid-group court hold is live for every payment mode';
END $d7_paid_group_hold$;
