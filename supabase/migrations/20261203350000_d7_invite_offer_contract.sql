-- D7 RUNTIME — THE SEALED INVITATION OFFER CONTRACT.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_PRIORITY_INVITE_DISPATCH_CONTRACT_V1`):
--   `ARCHITECTURE=ONE_SEALED_P_OWNED_OFFER_CONTRACT_PLUS_ONE_N_OWNED_TYPED_VERDICT`
--   `OFFER_DIGEST=COVERS_EVERY_FROZEN_FACT_IN_THE_ENUMERATED_ASSERTION_VECTOR_CANONICAL_UTC`
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
--
-- Five review rounds found the same defect four times: a fact the invitation ASSERTS that dispatch
-- did not re-read. Identity, then the operational gates, then the round, then the offer. Each fix
-- looked complete and the next round found the next fact, because the set was never enumerated —
-- it was discovered one review at a time, and the checks were re-implemented at three call sites
-- so a fix at one never reached the others.
--
-- This function is that enumeration, written down once. Everything the message promises is here,
-- and `offer_digest` is computed over ALL of it. A caller cannot ask a narrower question.
--
-- ── WHAT THE MESSAGE PROMISES, AND WHERE EACH FACT LIVES ───────────────────────────────────
--
--   the claim link              `slot_priority_claims.claim_token`      (a bearer credential)
--   which session, and when     `availability_slots.start_time/end_time`
--   how much                    `availability_slots.price_per_session`
--   by when to answer           `availability_slots.priority_window_ends_at`
--   which cycle, and its name   `cycles.name` via the slot
--   when the cycle starts       `cycles.start_date`
--   how payment works           `cycles.settings ->> 'rebook_payment_mode'`
--   how many sessions, and the  the PENDING claims sharing this claim's `rebook_group_id` AND its
--     range they span             person — the same aggregation the sender renders from
--   who it is addressed to      the guest's own address, else the profile's; and the account behind
--                                 a profile claim
--
-- ── CANONICAL, NOT `::text` ────────────────────────────────────────────────────────────────
--
-- Every instant enters the digest as `extract(epoch …)`, a number. `timestamptz::text` renders
-- through the session's `TimeZone`, so the identical stored instant produced a different digest for
-- a worker with a different setting — and a legitimate, unchanged invitation was held. A `date` is
-- rendered directly because a date has no zone, and the price is normalised to two decimals so
-- `20` and `20.00` are one offer rather than two.

DO $d7_offer_contract$
DECLARE
  v_n name;
  v_p name;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'related_slot_priority_claim_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 offer contract: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.d7_p_invite_contact(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'D7 offer contract: the batch this file supersedes is not installed';
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';
  SELECT c.relowner::regrole::name INTO v_p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='cycles';

  -- ── THE SAME WHITESPACE THE SENDER STRIPS ────────────────────────────────────────────────
  --
  -- `btrim(x)` removes ASCII spaces and nothing else. The sender trims with JavaScript `.trim()`,
  -- which removes the whole Unicode whitespace set. An imported address wrapped in tabs — or in the
  -- non-breaking space a spreadsheet paste leaves behind — is therefore CLEAN in the message and
  -- DECORATED in the authoritative read, and every enqueue for that recipient is refused as
  -- "changed between rendering and enqueue". The classes are made equal here rather than hoping the
  -- data is tidy.
  --
  -- Spelled as an explicit character list because `\s` is ASCII-only under LC_CTYPE C.
  EXECUTE $trim$
    CREATE OR REPLACE FUNCTION public.d7_trim_ws(p_text text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public
    AS $tb$
      SELECT btrim($1, E' \t\n\r\f\u000b'
                    || U&'\00a0' || U&'\1680' || U&'\2000' || U&'\2001' || U&'\2002'
                    || U&'\2003' || U&'\2004' || U&'\2005' || U&'\2006' || U&'\2007'
                    || U&'\2008' || U&'\2009' || U&'\200a' || U&'\2028' || U&'\2029'
                    || U&'\202f' || U&'\205f' || U&'\3000' || U&'\feff')
    $tb$
  $trim$;
  EXECUTE format('ALTER FUNCTION public.d7_trim_ws(text) OWNER TO %I', v_p);
  EXECUTE 'REVOKE ALL ON FUNCTION public.d7_trim_ws(text) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_trim_ws(text) TO %I', v_n);

  EXECUTE $offer$
    CREATE OR REPLACE FUNCTION public.d7_p_invite_offer(p_academy uuid, p_claim uuid)
    RETURNS TABLE (
      -- identity
      claim_id                uuid,
      player_id               uuid,
      guest_player_id         uuid,
      account_user_id         uuid,
      destination             text,
      claim_token             text,
      -- placement
      slot_id                 uuid,
      cyclus_id               uuid,
      rebook_group_id         uuid,
      capture_round_id        uuid,
      capture_slot_id         uuid,
      -- the promised offer
      start_time              timestamptz,
      end_time                timestamptz,
      price_per_session       numeric,
      priority_window_ends_at timestamptz,
      cyclus_name             text,
      cycle_start_date        date,
      cycle_status            text,
      series_leader_claim_id  uuid,
      payment_mode            text,
      group_sessions          int,
      group_first_start       timestamptz,
      group_last_start        timestamptz,
      -- the gate that is not part of the offer
      still_pending           boolean,
      -- every frozen fact above, in one value
      offer_digest            text
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $ob$
      WITH c AS (
        SELECT sc.*, s.start_time, s.end_time, s.price_per_session,
               s.priority_window_ends_at, s.cyclus_id, s.cyclus_name, s.academy_profile_id
          FROM public.slot_priority_claims sc
          JOIN public.availability_slots s ON s.id = sc.slot_id
         WHERE sc.id = p_claim
           AND s.academy_profile_id = p_academy
      ),
      cyc AS (
        -- CANONICAL TO WHAT THE MESSAGE ASSERTS, not to what the column holds. The email says one of
        -- two things — pay now, or pay when the cycle starts — so any mode that is not `upfront` is
        -- the same offer. Digesting the raw setting would make a rename of a non-upfront mode cancel
        -- invitations whose sentence never changed.
        --
        -- `cy.name` is deliberately NOT read here. The email prints `availability_slots.cyclus_name`,
        -- the denormalized copy on the session itself, and the two can disagree — reading the cycle's
        -- name would make the server compare a name the sender never rendered, and refuse EVERY
        -- invitation whose slot label had drifted. The rule throughout this contract is the same one:
        -- digest what the message SAYS, from the relation the message was rendered from.
        SELECT cy.id, cy.start_date, cy.status,
               CASE WHEN cy.settings ->> 'rebook_payment_mode' = 'upfront' THEN 'upfront' ELSE '' END AS payment_mode
          FROM public.cycles cy WHERE cy.id = (SELECT cyclus_id FROM c)
      ),
      -- THE SCOPE THE ACCEPT BOOKS, EXACTLY — `OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1`.
      --
      -- Review round 1 measured that this aggregation and `respond_to_priority_claim` disagreed. It
      -- grouped a person's siblings GUEST-FIRST (a guest id wins over a profile id on a dual-keyed
      -- row); the accept selects them PAIR-EXACT — `player_id` AND `guest_player_id` must both match
      -- (`20260703150000_rebook_strict_accept_and_release.sql`, both the decline loop and the
      -- booking loop). A representative claim `(P, G)` beside a sibling `(NULL, G)` was therefore
      -- DESCRIBED as two sessions and BOOKED as one: the mail made a promise the button did not keep.
      --
      -- The owner's decision is that the invitation's scope equals the booking scope, and that the
      -- booking scope does not widen to meet it. So the predicate below is the accept's predicate,
      -- copied, including `status = 'pending'` without a `coalesce` — matching what the accept
      -- actually tests rather than a more forgiving version of it.
      grp AS (
        -- NULL, NOT ZERO, when the claim has no group: the email then says nothing about a series at
        -- all, and a sender that omits the fact must agree with a server that has none.
        SELECT CASE WHEN (SELECT rebook_group_id FROM c) IS NULL THEN NULL ELSE count(*)::int END AS sessions,
               min(s2.start_time) AS first_start, max(s2.start_time) AS last_start
          FROM public.slot_priority_claims g
          JOIN public.availability_slots s2 ON s2.id = g.slot_id
         WHERE g.rebook_group_id IS NOT NULL
           AND g.rebook_group_id = (SELECT rebook_group_id FROM c)
           AND g.status = 'pending'
           AND g.player_id       IS NOT DISTINCT FROM (SELECT player_id FROM c)
           AND g.guest_player_id IS NOT DISTINCT FROM (SELECT guest_player_id FROM c)
      ),
      -- ── THE SERIES LEADER · ONE DEFINITION FOR THE WHOLE SYSTEM ──────────────────────────
      --
      -- `APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`. Six routes reach this contract, and until now
      -- THREE of them carried their own idea of which claim of a series gets the invitation: cycle
      -- discovery (pair-exact, but reading only the leader's own stamp), the direct paths (which
      -- suppressed a claim only when the leader happened to be in the same request), and
      -- `bulk-rebook-cycle` (guest-first and cycle-wide, the shape the owner's pair-exact decision
      -- ruled against). Two of those disagreeing produced two live bearer invitations for one accept
      -- scope — closure review 6's P1.
      --
      -- The rule is defined ONCE, here, and enforced where every route converges: the enqueue. The
      -- leader is the EARLIEST pending session of this exact `(group-or-slot, player, guest)` series,
      -- tie-broken by id so the order is total and two readers cannot disagree. A claim with no
      -- group is its own series, and therefore its own leader.
      lead AS (
        SELECT g.id
          FROM public.slot_priority_claims g
          JOIN public.availability_slots s3 ON s3.id = g.slot_id
         WHERE g.status = 'pending'
           AND g.player_id       IS NOT DISTINCT FROM (SELECT player_id FROM c)
           AND g.guest_player_id IS NOT DISTINCT FROM (SELECT guest_player_id FROM c)
           AND CASE WHEN (SELECT rebook_group_id FROM c) IS NULL
                    THEN g.id = p_claim
                    ELSE g.rebook_group_id = (SELECT rebook_group_id FROM c) END
         ORDER BY s3.start_time, g.id
         LIMIT 1
      ),
      cap AS (
        SELECT s.rebook_round_id AS rid, s.source_slot_id AS sid
          FROM public.rebook_round_recipient_claim_sources s
         WHERE s.source_claim_id = p_claim
         ORDER BY s.captured_at DESC, s.rebook_round_id DESC
         LIMIT 1
      ),
      f AS (
        SELECT
          c.id, c.player_id, c.guest_player_id,
          CASE WHEN c.guest_player_id IS NULL
               THEN (SELECT pr.user_id FROM public.profiles pr WHERE pr.id = c.player_id) END AS account_user_id,
          CASE WHEN c.guest_player_id IS NOT NULL
               THEN (SELECT nullif(public.d7_trim_ws(g.email), '') FROM public.guest_players g WHERE g.id = c.guest_player_id)
               ELSE (SELECT nullif(public.d7_trim_ws(pr.email), '') FROM public.profiles pr WHERE pr.id = c.player_id) END AS destination,
          c.claim_token, c.slot_id, c.cyclus_id, c.rebook_group_id,
          (SELECT rid FROM cap) AS capture_round_id,
          (SELECT sid FROM cap) AS capture_slot_id,
          c.start_time, c.end_time, c.price_per_session, c.priority_window_ends_at,
          c.cyclus_name,
          (SELECT start_date FROM cyc) AS cycle_start_date,
          -- NOT part of the offer's TERMS, and deliberately not digested: closing a cycle does not
          -- change what the message SAID. It changes whether the message may still be acted on, so
          -- it is reported as a live gate for the verdict to read (review round 4).
          (SELECT status FROM cyc) AS cycle_status,
          -- WHICH claim of this series carries the invitation. NOT digested: it is not one of the
          -- offer's terms, it is the identity of the message's subject, and the enqueue refuses any
          -- claim that is not it.
          (SELECT id FROM lead) AS series_leader_claim_id,
          -- '' WHEN THERE IS NO CYCLE AT ALL, not NULL. `availability_slots.cyclus_id` is
          -- nullable, and the sender renders this field from a BOOLEAN (`isUpfront ? 'upfront' : ''`)
          -- which is '' for a session with no cycle. A NULL here would disagree with that ''
          -- and refuse every invitation for a cycle-less session — the same two-source trap as
          -- the label, in its NULL form.
          CASE WHEN (SELECT payment_mode FROM cyc) = 'upfront' THEN 'upfront' ELSE '' END AS payment_mode,
          (SELECT sessions FROM grp) AS group_sessions,
          (SELECT first_start FROM grp) AS group_first_start,
          (SELECT last_start FROM grp) AS group_last_start,
          coalesce(c.status, 'pending') = 'pending' AS still_pending
        FROM c
      )
      SELECT f.*,
             -- ── THE SEAL ────────────────────────────────────────────────────────────────────
             --
             -- A JSON ARRAY, not a delimiter-joined string. Review round 2: joining unrestricted
             -- text with a pipe is NOT injective — a session label containing that delimiter can
             -- absorb the fields after it and give back byte-identical input for a DIFFERENT offer.
             -- (The old form is deliberately not spelled here: the catalog guard below greps this
             -- body for it, and a comment naming it would trip a check on its own explanation.) Slot
             -- labels are free text and the enqueue's address pattern admits pipes, so a coordinated
             -- pair (label, destination) could hold the seal still while both moved. `jsonb` escapes
             -- every element, so the framing cannot be forged from inside a field.
             --
             -- Every element is TEXT and every instant is an epoch: a `timestamptz` rendered to text
             -- goes through the session `TimeZone`, and a `date` through `DateStyle` (round 2 again —
             -- an `SQL, DMY` session serialises the same date differently), so both are pinned to a
             -- representation the session cannot move.
             encode(pg_catalog.sha256(pg_catalog.convert_to(
               jsonb_build_array(
                 'd7.invite.offer.v1',
                 coalesce(f.claim_token, ''),
                 coalesce(f.slot_id::text, ''),
                 coalesce(extract(epoch FROM f.start_time)::text, ''),
                 coalesce(extract(epoch FROM f.end_time)::text, ''),
                 -- The SAME canonical text the message quotes and the enqueue compares, so the
                 -- seal, the sentence and the check are one value rather than three roundings.
                 coalesce(to_char(f.price_per_session, 'FM999999999990.00'), ''),
                 coalesce(extract(epoch FROM f.priority_window_ends_at)::text, ''),
                 coalesce(f.cyclus_id::text, ''),
                 coalesce(f.cyclus_name, ''),
                 coalesce(to_char(f.cycle_start_date, 'YYYY-MM-DD'), ''),
                 coalesce(f.payment_mode, ''),
                 coalesce(f.rebook_group_id::text, ''),
                 coalesce(f.group_sessions::text, ''),
                 coalesce(extract(epoch FROM f.group_first_start)::text, ''),
                 coalesce(extract(epoch FROM f.group_last_start)::text, ''),
                 -- BOTH identity columns. The series scope is pair-exact, so the seal must be too:
                 -- re-pointing a dual-keyed claim from (P1, G) to (P2, G) leaves the guest, the
                 -- account (NULL for a guest claim) and the address all unmoved, and the accept then
                 -- books P2 against an invitation sealed for P1 (round 2).
                 coalesce(f.player_id::text, ''),
                 coalesce(f.guest_player_id::text, ''),
                 coalesce(f.account_user_id::text, ''),
                 coalesce(f.destination, '')
               )::text, 'UTF8')), 'hex')
        FROM f
    $ob$
  $offer$;
  EXECUTE format('ALTER FUNCTION public.d7_p_invite_offer(uuid,uuid) OWNER TO %I', v_p);
  EXECUTE 'REVOKE ALL ON FUNCTION public.d7_p_invite_offer(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_invite_offer(uuid,uuid) TO %I', v_n);

  -- PROVED FROM THE CATALOG: the digest reads no instant as text, which is the whole point of it
  -- being canonical. A single `::text` on a timestamptz would reintroduce the session-timezone hold.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.d7_p_invite_offer(uuid,uuid)')
       AND (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%start_time::text%'
            OR p.prosrc LIKE '%end_time::text%'
            OR p.prosrc LIKE '%priority_window_ends_at::text%'
            OR p.prosrc LIKE '%first_start::text%' OR p.prosrc LIKE '%last_start::text%'
            -- A DATE rendered with `::text` follows `DateStyle`, which is session state exactly as
            -- `TimeZone` is (review round 2). Same rule, same guard.
            OR p.prosrc LIKE '%cycle_start_date::text%')) THEN
    RAISE EXCEPTION 'D7 offer contract: an instant or date reaches the digest as text, which is session-dependent';
  END IF;
  -- THE SEAL IS FRAMED, NOT JOINED. `concat_ws` over free text is not injective: a pipe inside a
  -- session label can absorb the fields behind it. The digest must build a jsonb array.
  --
  -- GREPPED WITH THE COMMENTS STRIPPED. `prosrc` is the literal body INCLUDING its comments, so a
  -- check for the token `jsonb_build_array` is satisfied by a comment MENTIONING it — and the
  -- comment two screens up does exactly that. An adversarial reader demonstrated the whole
  -- mutation: restore the delimiter join and leave `-- jsonb_build_array` behind, and this guard,
  -- the sibling guard in the wiring test and the behavioural test all stay green.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.d7_p_invite_offer(uuid,uuid)')
       AND (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%concat_ws%'
            OR regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%array_to_string%'
            OR regexp_replace(p.prosrc, '--[^\n]*', '', 'g') NOT LIKE '%jsonb_build_array%')) THEN
    RAISE EXCEPTION 'D7 offer contract: the digest must be framed by jsonb, not joined by a delimiter';
  END IF;
  -- AND IT SEALS BOTH IDENTITY COLUMNS, because the series scope is pair-exact.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.d7_p_invite_offer(uuid,uuid)')
       AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') NOT LIKE '%f.player_id::text%') THEN
    RAISE EXCEPTION 'D7 offer contract: the digest omits the profile half of the identity pair';
  END IF;

  RAISE NOTICE 'D7: the invitation offer is enumerated once, and digested whole';
END $d7_offer_contract$;
