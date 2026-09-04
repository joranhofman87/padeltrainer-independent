// @vitest-environment node
// Codex round-11 #3: token co-occurrence pins are false-green capable (moving the scan before the gate,
// or a dead helper call beside a restored unbounded query, would still pass). These are AST-STRUCTURAL
// assertions — they prove the real call GRAPH, not just that a token appears somewhere. Each is
// mutation-verified against the exact bypass Codex named.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function parse(path: string[], kind: ts.ScriptKind): ts.SourceFile {
  const text = readFileSync(join(process.cwd(), ...path), 'utf8');
  return ts.createSourceFile(path[path.length - 1], text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);
}
const component = (name: string) => parse(['src', 'components', 'cycles', name], ts.ScriptKind.TSX);
const edge = (name: string) => parse(['supabase', 'functions', name, 'index.ts'], ts.ScriptKind.TS);
const lib = (name: string) => parse(['src', 'lib', name], ts.ScriptKind.TS);

/** All CallExpressions whose callee is `name(` or `x.name(`. */
function calls(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      const callee = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
      if (callee === name) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
function firstArgString(c: ts.CallExpression): string | null {
  const a = c.arguments[0];
  return a && ts.isStringLiteral(a) ? a.text : null;
}
/** The `scan:` property value node of a gate call's options object, if any. */
function gateScanProp(gate: ts.CallExpression): ts.Node | null {
  const arg = gate.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  const scan = arg.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name) && p.name.text === 'scan');
  return scan ?? null;
}

describe('rebook orchestration wiring pins — AST-structural (Codex round-11 #3)', () => {
  it('BOTH wizards use shared preview/create orchestration and contain zero direct bulk invokes', () => {
    for (const wizard of ['RebookCohortWizard.tsx', 'AcademyNewRoundWizard.tsx']) {
      const sf = component(wizard);
      expect(calls(sf, 'createAndDrainRebookRound').length, `${wizard} calls the shared orchestration`).toBeGreaterThan(0);
      expect(calls(sf, 'previewRebookRound').length, `${wizard} calls the shared preview boundary`).toBeGreaterThan(0);
      const bulkInvokes = calls(sf, 'invoke').filter((c) => firstArgString(c) === 'bulk-rebook-cycle');
      expect(bulkInvokes, `${wizard} must not bypass the shared boundaries`).toHaveLength(0);
    }

    // THE SHARED BOUNDARY NO LONGER OWNS A BULK INVOKE — it owns the typed selection surface.
    //
    // This pin used to assert the opposite: that `previewRebookRound` contained EXACTLY ONE literal
    // `invoke('bulk-rebook-cycle', … dryRun:true …)`, because the risk then was a wizard reaching
    // past the shared boundary to the edge function. The edge producer is gone, so the pin is
    // INVERTED rather than deleted — the risk it guards has not disappeared, it has moved: a
    // second producer would now be a stray `functions.invoke` anywhere in the chain.
    const helper = lib('rebookInviteSend.ts');
    const previews: ts.FunctionDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'previewRebookRound') previews.push(node);
      ts.forEachChild(node, visit);
    };
    visit(helper);
    expect(previews, 'previewRebookRound must have one unique function declaration').toHaveLength(1);
    expect(calls(helper, 'invoke').filter((c) => firstArgString(c) === 'bulk-rebook-cycle'),
      'the shared boundary must not reach the retired producer').toHaveLength(0);

    // …and neither may the driver it delegates to, which is the only thing between the wizards and
    // the database now.
    const driver = lib('rebookSelectionDriver.ts');
    expect(calls(driver, 'invoke').filter((c) => firstArgString(c) === 'bulk-rebook-cycle'),
      'the selection driver must not reach the retired producer either').toHaveLength(0);
    // It reaches the two typed surfaces, and nothing else: a third RPC name here would be a third
    // authority the review never saw.
    const rpcNames = [...new Set(calls(driver, 'rpc').map(firstArgString).filter((x): x is string => x !== null))].sort();
    expect(rpcNames, 'exactly the two selection surfaces').toEqual([
      'rebook_round_selection_apply_as_actor',
      'rebook_round_selection_preview_as_actor',
    ]);
  });

  it('send-rebook-group-confirmation runs the full member scan INSIDE gateGroupConfirmation.scan (not before the gate)', () => {
    const sf = edge('send-rebook-group-confirmation');
    const gates = calls(sf, 'gateGroupConfirmation');
    expect(gates.length, 'exactly one admission gate').toBe(1);
    const scanProp = gateScanProp(gates[0]);
    expect(scanProp, 'the gate has a `scan` step').not.toBeNull();
    // The member scan (fetchAllKeyset) must live INSIDE the gate's scan step. Moving it before/outside
    // the gate (Codex's mutation) leaves the scan step without a fetchAllKeyset → this fails.
    const keysetInScan = calls(sf, 'fetchAllKeyset').filter((c) => within(c, scanProp!));
    expect(keysetInScan.length, 'the paginated member scan is inside the gate.scan').toBeGreaterThan(0);
  });

  // TWO, NOT THREE. `notify-rebook-member-open` was the third discovery sender and D7's runtime
  // cutover hard-retired it. Its pagination obligation did not disappear — it moved into the
  // database, where the recipient universe is enumerated by `rebook_round_materialize` under the
  // round's own 2 000-recipient ceiling with an explicit `has_more`, which is a stronger bound
  // than "the client remembered to chunk". The two surviving senders keep this pin unchanged.
  // ── WHAT THE SENDER MAY COUNT AS A SEND ────────────────────────────────────────────────────
  //
  // Two review findings live here, and neither had any sender-level test at all.
  //
  // A SUPPRESSED address returns from the enqueue core BEFORE its only INSERT: no outbox row, no
  // `invited_at`, nothing that will ever be delivered. Counting it as `sent` made the endpoint
  // answer `sent: 1` for a claim with no row, and the client — seeing no failures — declared the
  // drain complete while the claim stayed eligible forever.
  //
  // An ALREADY-ENQUEUED claim is the same shape of lie in the other direction: the idempotency key
  // is permanent, so no second message can exist, including for an explicit `resend`.
  //
  // Both must map to the `already` outcome, which the loop counts as skipped. This is a source pin
  // because the branch is unreachable from the unit harness — but it is a precise one: it names the
  // two skip reasons and the outcome each must produce.
  it('the invitation sender counts only a real enqueue as a send', () => {
    const src = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'send-priority-claim-invitation', 'index.ts'), 'utf8');
    for (const reason of ['email_suppressed', 'already_enqueued']) {
      expect(src, `${reason} must be recognised`).toContain(reason);
    }
    // SURFACED, NOT SWALLOWED. `readChunkResponse` discards `skipped`, so a chunk of nothing but
    // skips reads as a clean drain while the claim stays unstamped and is rediscovered forever.
    // Review round 3: a suppressed address and an existing row that can no longer be sent both need
    // a human, so they travel on the `unresolved` channel the drain already propagates.
    // ONE TERMINAL OUTCOME PER ATTEMPT (`APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`). The buckets are
    // disjoint and exhaustive, so no consumer has to reason about an overlap — three review rounds
    // in a row found one that had reasoned about it wrongly.
    expect(src, 'a suppressed address is its own outcome')
      .toMatch(/skip_reason === "email_suppressed"\)\s*\{[\s\S]{0,200}?outcome: "suppressed"/);
    expect(src, 'a held existing row is its own outcome')
      .toMatch(/skip_reason === "existing_row_not_sendable"\)\s*\{[\s\S]{0,200}?outcome: "held"/);
    // ...and an existing row whose stamp repair fails is STILL `already`, never a fresh send.
    expect(src, 'a stamp failure on an existing row is not a new send')
      .toMatch(/return already\s*\n?\s*\? \{ outcome: "already"/);
    // THE INVARIANT IS ASSERTED, not merely intended.
    expect(src, 'the outcome buckets are checked against what was attempted')
      .toMatch(/const accounted = queued \+ already \+ suppressed \+ held \+ unstamped \+ failed;/);
    expect(src, 'and a disagreement is refused rather than answered')
      .toMatch(/if \(accounted !== attempted\) \{[\s\S]{0,120}?throw new Error\(/);
    // AND A ZERO-SEND MUST NOT INCREMENT `sent`. Round 4: both new outcomes travelled on the
    // `unresolved` arm, which exists for "the provider call happened and the stamp did not" and so
    // increments `sent`. That inflated totals, told a single-claim resend "Invitation sent", and
    // kept the drain's no-progress guard from firing, so the same claim was re-attempted to the
    // iteration limit while later recipients waited.
    expect(src, 'a suppressed claim is never counted as queued')
      .toMatch(/outcome === "suppressed"\)\s*\{\s*\n\s*suppressed\+\+;/);
    const supArm = src.slice(src.indexOf('outcome === "suppressed"'));
    expect(supArm.slice(0, supArm.indexOf('continue;')), 'and it queues nothing')
      .not.toContain('queued++');
    // And the already-queued branch flows into the same outcome.
    expect(src, 'an already-queued claim is not counted as a send')
      .toMatch(/outcome: already \? "already" : "ok"/);
    // The loop turns that outcome into `skipped`, never `sent`.
    expect(src, 'the already outcome is its own bucket')
      .toMatch(/outcome === "already"\)\s*\{\s*\n?\s*already\+\+;/);

    // AND THE BRANCHES ABOVE ARE REACHED. Every assertion in this test matches text ANYWHERE in the
    // file, so replacing the live call with a hard-coded `{ outcome: "ok" }` would leave the helper
    // and all its branches intact as dead code and every pin green — while the endpoint counted
    // sends for claims it never enqueued. Review round 1 named that exact mutation. The live call
    // site is therefore pinned too.
    // BOUND TO THE TERNARY, not merely present in the file. Round 2: requiring the TEXT
    // `: await enqueueOne()` anywhere is satisfied by flipping the condition to `!isTest ? … :
    // await enqueueOne()`, which routes LIVE traffic to the direct Resend branch and leaves the
    // enqueue as dead code — with every pin here still green. The whole discriminator is which side
    // of `isTest ?` each branch sits on, so that is what is asserted.
    expect(src, 'the TEST branch is the direct-provider send, and the LIVE branch is the enqueue')
      .toMatch(/const \{ outcome, error: sendError \} = isTest\s*\n\s*\? await sendThenStampOne\(\{[\s\S]*?\n\s*: await enqueueOne\(\);/);
    expect(src, 'and nothing short-circuits the live branch with a fabricated success')
      .not.toMatch(/:\s*\{\s*outcome:\s*"ok"\s*\}/);
    // The direct provider call exists ONLY inside the test branch.
    const ternary = src.slice(src.indexOf('const { outcome, error: sendError } = isTest'));
    const live = ternary.slice(ternary.indexOf('\n          : '));
    expect(live.slice(0, 200), 'the live branch reaches no provider directly')
      .not.toContain('sendResendEmail');
  });

  // ── THE SENDER AND THE SERVER MUST READ THE SAME RELATION ────────────────────────────────
  //
  // The enqueue compares fifteen rendered facts against its own authoritative read and refuses on
  // any mismatch. That is only safe while both sides read the SAME source — and `cyclus_name` is a
  // trap, because it exists in two places: `cycles.name`, and the denormalized `cyclus_name` column
  // on `availability_slots`. The email prints the SESSION's copy. A server that read the cycle row
  // instead would compare a name the sender never rendered and refuse EVERY invitation whose slot
  // label had drifted from its cycle — a total outage of the invitation path, invisible to any test
  // whose fixture reads its "rendered" facts from the server in the first place.
  //
  // So the pin is on the pair, not on either half.
  // ── NO SURFACE SAYS "SENT" FOR A DURABLE ENQUEUE ─────────────────────────────────────────
  //
  // `invited_at` is stamped after an ENQUEUE. Delivery is the D7 worker's, and every D7 schedule is
  // inactive — so a screen saying "sent" is telling the academy something untrue. Round 2 moved the
  // strings; round 3 found the conversion was SHADOWED: i18next resolves `key_one`/`key_other` when
  // a `count` is supplied, and the plural siblings still said "sent", so the corrected unsuffixed
  // key was dead text. The sweep below is over the plural forms too, which is the only version of
  // this check that would have caught it.
  it('no invitation-outcome string claims delivery, in either language or any plural form', () => {
    const claimsDelivery = /\b(sent|verstuurd)\b/i;
    // The invitation-outcome keys. Reminders are a DIFFERENT event that does reach a provider, and
    // are deliberately not in this list.
    const bases = ['successEmails', 'resumeDone', 'resumePartial', 'uninvited', 'partial',
      'sendingInvites', 'sending', 'inviteNotSentShort', 'invitationQueued', 'allQueued',
      'claimNotResent', 'nothingToInvite', 'emailsNotQueued'];
    for (const lang of ['en', 'nl']) {
      const dict = JSON.parse(readFileSync(
        join(process.cwd(), 'src', 'i18n', 'locales', lang, 'cycles.json'), 'utf8'));
      for (const [section, entries] of Object.entries(dict)) {
        if (typeof entries !== 'object' || entries === null) continue;
        for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
          if (typeof value !== 'string') continue;
          if (!bases.includes(key.split('_')[0])) continue;
          // Interpolation placeholders are variable NAMES, not copy — `{{sent}}` is the count of
          // things queued, and reads as "sent" only to a regex.
          expect(value.replace(/\{\{[^}]*\}\}/g, ''), `${lang}.${section}.${key} must not claim delivery`)
            .not.toMatch(claimsDelivery);
        }
      }
    }
  });

  // ── VISIBLE IS NOT OWNED ─────────────────────────────────────────────────────────────────
  //
  // The non-service path resolves which claims a caller may invite. It used to do that by SELECTing
  // under the caller's JWT and trusting RLS — but PostgreSQL ORs permissive SELECT policies, so
  // "Players read own priority claims" satisfied a probe meant to prove "Slot owners manage
  // priority claims". A player with a pending claim could drive this endpoint for their own claim,
  // choose the custom copy, and enqueue and stamp their own branded invitation (review round 3).
  //
  // The rule is the one the cycle path already followed: RLS decides what a caller may READ, never
  // what they may COMMAND. Ownership is proven with the service client afterwards.
  it('every caller path sends ONE invitation per pair-exact series', () => {
    // `OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1` says one invitation describes and
    // books one exact `(player, guest)` series. `cycleId` mode collapsed to the earliest claim of
    // each series; the direct `claimIds`/`slotId` paths processed what they were handed, verbatim.
    // A manager inviting the same player from two weekly slot pages of one series therefore made
    // two live outbox rows — different claims, tokens and digests, so different idempotency keys —
    // and both could reach the provider for a series that ONE click books (review round 4).
    const src = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'send-priority-claim-invitation', 'index.ts'), 'utf8');
    // ONE LEADER, NAMED BY THE SERVER. Three routes used to carry their own rule; the offer names
    // `series_leader_claim_id`, the enqueue REFUSES anything else, and the sender maps onto it so a
    // click on week two still works. A divergence therefore fails closed with no row, instead of
    // producing a second bearer invitation for one accept scope.
    expect(src, 'the sender maps every claim onto its leader')
      .toMatch(/const leaderOf = new Map<string, string>\(\);/);
    expect(src, 'and enqueues the leader, not the claim that was clicked')
      .toMatch(/const byLeader = new Map/);
    expect(src, 'a claim merged into its leader is reported, not silently dropped')
      .toContain('mergedIntoLeader');
    // The proposal orders exactly as the offer does: earliest session, then id.
    expect(src, 'the leader proposal is total and deterministic')
      .toMatch(/a\.start < b\.start \? a : b\.start < a\.start \? b : \(a\.id <= b\.id \? a : b\)/);
    // ...and the DATABASE is the authority, refusing any non-leader.
    const enqueueSql = readFileSync(join(process.cwd(), 'supabase', 'migrations',
      '20261203370000_d7_invite_enqueue_contract.sql'), 'utf8');
    expect(enqueueSql, 'the enqueue refuses a claim that is not its series leader')
      .toContain('f.series_leader_claim_id IS DISTINCT FROM p_claim');
    expect(enqueueSql, 'and refuses a closed cycle before any write')
      .toContain("f.cyclus_id IS NOT NULL AND f.cycle_status IS DISTINCT FROM 'open'");
    // Cycle discovery treats `invited` as a property of the SERIES, not of the leader.
    expect(src, 'any stamped sibling means the series is invited')
      .toMatch(/const invited = \(cur\?\.invited \?\? false\) \|\| !!c\.invited_at;/);
  });

  it('the invitation sender proves slot ownership rather than inferring it from RLS visibility', () => {
    const src = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'send-priority-claim-invitation', 'index.ts'), 'utf8');
    const probe = src.slice(src.indexOf('let ownQuery'), src.indexOf('let query = supabase'));
    expect(probe, 'the JWT read is treated as VISIBILITY, not as authorization')
      .toMatch(/const visibleIds\b/);
    expect(probe, 'and authorizedIds is not simply the visible set')
      .not.toMatch(/authorizedIds = \(ownRows \|\| \[\]\)/);
    // Ownership is re-established against the slot, with the service client, using the POLICY's own
    // definition of an owner. "Slot owners manage priority claims" names three arms, and all three
    // are reproduced — including the trainer arm going through `trainer_profiles`, because
    // `availability_slots.trainer_id` is a `trainer_profiles.id` and NOT an auth user id. The first
    // version of this proof compared it to `callerUserId` directly, which would have 403'd every
    // legitimate trainer (review round 4).
    expect(probe, 'the trainer arm maps the slot profile to the caller, not to a bare id')
      .toMatch(/from\("trainer_profiles"\)[\s\S]{0,120}?\.eq\("user_id", callerUserId\)[\s\S]{0,60}?\.in\("id", trainerIds\)/);
    expect(probe, 'and never compares a trainer profile id to a user id')
      .not.toMatch(/slot\.trainer_id === callerUserId/);
    expect(probe, 'the academy arm asks academy_managers under the service client')
      .toMatch(/from\("academy_managers"\)[\s\S]{0,200}?\.eq\("user_id", callerUserId\)/);
    expect(probe, 'and the club arm exists too, as the policy has one')
      .toMatch(/get_user_club_ids[\s\S]{0,400}?from\("club_profiles"\)/);
    // The three arms are the ONLY ways in.
    expect(probe, 'ownership is exactly those three arms')
      .toMatch(/ownedTrainers\.has[\s\S]{0,200}?managedAcademies\.has[\s\S]{0,200}?managedLocations\.has/);
    // A caller with no identity authorizes nothing.
    expect(probe, 'an anonymous caller resolves no claims').toMatch(/visibleIds\.length > 0 && callerUserId/);
  });

  it('the invitation sender and the offer contract read the cycle label from the same column', () => {
    const sender = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'send-priority-claim-invitation', 'index.ts'), 'utf8');
    const loader = readFileSync(
      join(process.cwd(), 'supabase', 'functions', '_shared', 'rebook-invitation-context.ts'), 'utf8');
    const offer = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20261203350000_d7_invite_offer_contract.sql'), 'utf8');

    // The sender renders the slot's own label...
    expect(sender, 'the email prints the session label').toContain('slot.cyclus_name');
    expect(sender, 'and sends that same value as the rendered fact')
      .toMatch(/cyclus_name:\s*slot\.cyclus_name/);
    expect(loader, 'which is read from availability_slots')
      .toMatch(/from\("availability_slots"\)[\s\S]{0,200}cyclus_name/);

    // ...and the server digests the slot's own label, never the cycle row's name.
    expect(offer, 'the offer selects the slot label').toMatch(/s\.cyclus_id,\s*s\.cyclus_name/);
    expect(offer, 'and projects it straight through').toMatch(/^\s*c\.cyclus_name,$/m);
    expect(offer, 'the cycle row is read for its date and mode only — never for its name')
      .not.toMatch(/SELECT\s+cy\.id,\s*cy\.name/);
  });

  // ── WHAT THE DIGEST DELIBERATELY DOES NOT COVER ──────────────────────────────────────────
  //
  // The offer digest decides two things: whether a frozen message may still be sent, and whether a
  // re-invitation is a NEW message. So the boundary matters in BOTH directions — a fact left out
  // lets a stale promise go out, and a fact wrongly included cancels live invitations for a change
  // nobody would call a new offer.
  //
  // Four rendered values are outside it, on purpose, and this test is where that choice is written
  // down rather than left implicit in a SQL file nobody diffs.
  //
  //   `recipientName`  — a salutation. Fixing a misspelled name is not a new offer, and re-mailing
  //                      everyone because a manager corrected one is worse than the typo.
  //   `academyName`    — branding. Same reasoning, and it is frozen into the request bytes anyway,
  //                      so the message that goes out is the one that was rendered.
  //   `replyTo`        — likewise frozen into the request bytes; changing the academy's address
  //                      later cannot alter what is already sealed.
  //   the academy `tz` — a RENDERING of instants the digest already covers as epochs. The session
  //                      did not move; only the words describing it would have.
  //
  // Everything else the email asserts IS covered, and `d7RuntimeContract.realpg.test.ts` sweeps
  // those one at a time.
  it('the sender sends every field the server requires, by name', () => {
    // The realpg suite cannot see this. Its enqueue helper builds `d7_rendered` from the server's
    // own reader, so deleting a key from the TypeScript object at the sender leaves every database
    // assertion green — while every live enqueue carrying that shape is refused as "was enqueued
    // without every fact it was rendered from". Review round 1 named the exact mutation
    // (`cycle_start`). The two lists are therefore compared to each other, here, statically.
    const sender = readFileSync(
      join(process.cwd(), 'supabase', 'functions', 'send-priority-claim-invitation', 'index.ts'), 'utf8');
    const core = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20261203370000_d7_invite_enqueue_contract.sql'), 'utf8');

    const start = core.indexOf("e ?& ARRAY[");
    const required = [...core.slice(start, core.indexOf("]) THEN", start))
      .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // SIXTEEN since round 3: `player_id` joined them, because the accept books the exact
    // (player, guest) pair and the message has to be bound to the pair it was rendered for.
    expect(required.length, 'the server requires sixteen named fields').toBe(16);

    const rendered = sender.slice(sender.indexOf('d7_rendered: {'), sender.indexOf('...(replyTo'));
    for (const field of required) {
      expect(rendered, `the sender sends ${field}`).toMatch(new RegExp(`\\b${field}:`));
    }
    // THE CYCLE START IS RENDERED IN UTC. A plain DATE has no time and no zone; anchoring it at
    // noon UTC and formatting it in the academy zone lands on the NEXT day for every zone at or
    // past UTC+12. No database test can see this — the contract compares the raw `YYYY-MM-DD`
    // binding, which is correct on both sides while the HTML states the wrong day (round 2).
    expect(sender, 'the cycle-start line is formatted in UTC, not the academy zone')
      .toMatch(/cycleStartRaw[\s\S]{0,240}?timeZone: "UTC"/);

    // THE PRICE IS ECHOED AS THE RENDERED STRING. This is the half of the round-1 price fix that
    // no database test can see: the realpg helper builds `d7_rendered` from the server's own
    // reader, so reverting this to the raw column leaves every one of those assertions green while
    // the mail quotes `Number(x).toFixed(2)` and the seal carries PostgreSQL's rounding of the same
    // stored value — 2.67 printed, 2.68 sealed.
    expect(rendered, 'the price echo is what the HTML prints, not the raw column')
      .toMatch(/price:[\s\S]{0,200}?Number\(slot\.price_per_session\)\.toFixed\(2\)/);
    expect(sender, 'and the HTML prints the same expression')
      .toMatch(/EUR \$\{Number\(slot\.price_per_session\)\.toFixed\(2\)\}/);

    // ...and sends NOTHING ELSE, because an extra key is a fact the server never checks.
    const sent = [...rendered.matchAll(/^\s{14}([a-z_]+):/gm)].map((m) => m[1]);
    expect([...new Set(sent)].sort(), 'the two lists are the same set').toEqual([...required].sort());
  });

  it('the offer digest covers what the email PROMISES, and deliberately not what it merely says', () => {
    const offer = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20261203350000_d7_invite_offer_contract.sql'), 'utf8');
    const digestStart = offer.indexOf("'d7.invite.offer.v1'");
    const digestEnd = offer.indexOf("::text, 'UTF8')", digestStart);
    expect(digestEnd, 'the digest block is locatable and bounded').toBeGreaterThan(digestStart);
    const digest = offer.slice(digestStart, digestEnd);

    for (const covered of [
      'f.claim_token', 'f.slot_id', 'f.start_time', 'f.end_time', 'f.price_per_session',
      'f.priority_window_ends_at', 'f.cyclus_id', 'f.cyclus_name', 'f.cycle_start_date',
      'f.payment_mode', 'f.rebook_group_id', 'f.group_sessions', 'f.group_first_start',
      // BOTH identity columns: the series scope is pair-exact, so re-pointing a dual-keyed claim
      // from (P1, G) to (P2, G) must move the seal even though the guest, the account and the
      // address all stay put (review round 2).
      'f.group_last_start', 'f.player_id', 'f.guest_player_id', 'f.account_user_id', 'f.destination',
    ]) {
      expect(digest, `${covered} is part of the promise`).toContain(covered);
    }
    // EIGHTEEN, counted. A silent addition changes what counts as a re-invitation; a silent
    // removal lets a stale promise through. Either way it should have to come here first.
    expect((digest.match(/coalesce\(/g) ?? []).length, 'exactly eighteen facts, no more').toBe(18);
    // ...and they are FRAMED, not joined. Joining free text with a delimiter is not injective: a
    // session label containing that delimiter can absorb the fields behind it, so two different
    // offers hash the same bytes (round 2). jsonb escapes every element.
    expect(offer.slice(digestStart - 200, digestEnd), 'the seal is framed by jsonb')
      .toContain('jsonb_build_array');
    expect(offer.slice(digestStart - 200, digestEnd), 'and not joined by a delimiter')
      .not.toMatch(/concat_ws\(\s*'\|'/);

    // ...and the four that are NOT, named so that adding one is a decision rather than a drift.
    for (const excluded of ['full_name', 'business_name', 'reply_to', 'timezone']) {
      expect(digest, `${excluded} is deliberately outside the offer`).not.toContain(excluded);
    }
  });

  it('both remaining discovery senders read claims ONLY through fetchAllInChunks (no unbounded slot_id query escapes it)', () => {
    for (const name of ['send-priority-claim-invitation', 'send-rebook-reminder']) {
      const sf = edge(name);
      const chunks = calls(sf, 'fetchAllInChunks');
      expect(chunks.length, `${name} uses fetchAllInChunks`).toBeGreaterThan(0);
      // EVERY `.in("slot_id", …)` claims read must be inside a fetchAllInChunks call. A restored
      // unbounded query (Codex's mutation) reads slot_id at the top level → not within any chunk → fails,
      // even if a dead fetchAllInChunks call lingers.
      const slotReads = calls(sf, 'in').filter((c) => firstArgString(c) === 'slot_id');
      expect(slotReads.length, `${name} has a slot_id claims read`).toBeGreaterThan(0);
      for (const r of slotReads) {
        expect(chunks.some((ch) => within(r, ch)), `${name}: a slot_id read escapes fetchAllInChunks (unbounded)`).toBe(true);
      }
    }
  });
});
