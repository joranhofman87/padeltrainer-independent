import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { resolveAppBase } from "../_shared/priority-claim-invite.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { computeMemberOpenAudience, recipientKey, releaseMemberOpenClaim, resolveMemberOpenContact, runClaimedCycle, type MemberOpenClaim, type MemberOpenContactMaps } from "../_shared/rebook-member-open.ts";
import { fetchAllInChunks, fetchAllKeyset } from "../_shared/paginate.ts";

// Cron-invoked (service-role) notifier: when a rebook round's MEMBER window opens
// and seats have freed up, email the "second bucket" — the original-cohort players
// who didn't rebook + the registered priority list — that they can book now.
// Idempotent per round via cycles.settings.rebook_member_open_notified_at (claimed
// atomically before send). RB03: successfully-emailed recipients are recorded per
// person in settings.rebook_member_open_notified_recipients; on ANY send failure the
// marker is released so the next tick re-detects the round and re-sends ONLY the
// recipients that failed — never a duplicate to a successful one, never a silent drop.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));
const FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";
const MAX_CYCLES_PER_RUN = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const substituteVars = (text: string, fullName: string) => {
  const full = (fullName || "").trim();
  const first = full.split(/\s+/)[0] || full;
  return text.replace(/\{first_name\}/g, first).replace(/\{full_name\}/g, full);
};
const renderCustomMessage = (message: string, fullName: string): string => {
  const msg = (message || "").trim();
  if (!msg) return "";
  const paras = substituteVars(msg, fullName)
    .split("\n")
    .map((line) => `<p style="color:#374151;line-height:1.6;margin:0 0 8px;">${escapeHtml(line)}</p>`)
    .join("");
  return `<div style="background:#ffffff;border-left:3px solid #f45d25;padding:8px 0 8px 14px;margin:16px 0;">${paras}</div>`;
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

  // Service-role only (this is a cron/internal fn — no user path).
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (token !== serviceKey) return json({ error: "unauthorized" }, 401);
  if (!resendApiKey) return json({ error: "email_not_configured" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { data: cands, error: candErr } = await supabase.rpc("rebook_cycles_needing_member_open_notice");
    if (candErr) throw candErr;
    const cycleIds = ((cands ?? []) as Array<{ cycle_id: string }>).map((r) => r.cycle_id).slice(0, MAX_CYCLES_PER_RUN);

    let cyclesProcessed = 0;
    let totalSent = 0;

    // ROUND DEDUP: a per-series rebook round creates SIBLING cycles sharing one
    // settings.rebook_round_id and ONE priority list, all opening at the same instant.
    // One "sessions opened" email per person per ROUND — the first due cycle of a round
    // sends; its siblings are claimed silently (both within this tick and across ticks).
    // Fail loud: if this read errors, roundOf is empty → every cycle loses its round id → sibling
    // cycles of the SAME round each send the "sessions opened" email (duplicate). Nothing is claimed
    // yet, so a throw safely aborts the whole run (500 → next tick retries).
    const { data: dueRows, error: dueErr } = await supabase.from("cycles").select("id, settings").in("id", cycleIds);
    if (dueErr) throw new Error(`member-open round lookup failed: ${dueErr.message}`);
    const roundOf = new Map<string, string | null>();
    for (const r of dueRows ?? []) {
      roundOf.set(r.id, ((r.settings as Record<string, unknown> | null)?.rebook_round_id as string | undefined) ?? null);
    }
    const seenRounds = new Set<string>();
    const roundAlreadyNotified = async (round: string, selfId: string): Promise<boolean> => {
      const { data, error } = await supabase.from("cycles").select("id")
        .eq("settings->>rebook_round_id", round)
        .neq("id", selfId)
        .not("settings->>rebook_member_open_notified_at", "is", null)
        .limit(1);
      if (error) throw new Error(`member-open round-sibling read failed: ${error.message}`);
      return (data ?? []).length > 0;
    };

    for (const cycleId of cycleIds) {
      // Atomic claim: stamp notified_at IF NULL. Lost race ⇒ another run has it. The
      // claim serializes this round so the per-recipient bookkeeping below is race-free.
      const { data: claimed, error: claimErr } = await supabase.rpc("claim_rebook_member_open_notice", { _cycle_id: cycleId });
      if (claimErr) { await notifySlackEdgeError("notify-rebook-member-open", `claim failed: ${claimErr.message}`, { cycleId }); continue; }
      if (claimed !== true) continue;

      // Sibling-of-an-already-notified-round short-circuit (keep the claim, send nothing). A read
      // error here must RELEASE the claim so the round is retried, not silently stranded as claimed.
      const round = roundOf.get(cycleId) ?? null;
      if (round) {
        let sibling = seenRounds.has(round);
        if (!sibling) {
          try {
            sibling = await roundAlreadyNotified(round, cycleId);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const relErr = await releaseMemberOpenClaim(supabase, cycleId); // surface an unclaim failure too
            await notifySlackEdgeError("notify-rebook-member-open", relErr ? `${msg}; ${relErr}` : msg, { cycleId });
            continue;
          }
        }
        if (sibling) { cyclesProcessed += 1; continue; }
        seenRounds.add(round);
      }

      cyclesProcessed += 1;
      const outcome = await runClaimedCycle(supabase, cycleId, (id) => notifyCycle(supabase, resendApiKey, id));
      totalSent += outcome.sent;
      if (outcome.error) {
        await notifySlackEdgeError("notify-rebook-member-open", outcome.error, { cycleId });
      } else if (outcome.failed > 0) {
        await notifySlackEdgeError("notify-rebook-member-open", `partial send: ${outcome.sent} ok, ${outcome.failed} failed`, { cycleId });
      }
    }

    return json({ ok: true, cyclesProcessed, totalSent });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await notifySlackEdgeError("notify-rebook-member-open", message);
    return json({ error: message }, 500);
  }
};

// Emails the second bucket for one round. Returns { sent, failed }; the caller releases
// the idempotency marker (retry) when failed > 0. Successful recipients are recorded per
// person in settings.rebook_member_open_notified_recipients so a retry never re-sends to
// them (RB03). The client is the untyped Deno service client (no generated Database types),
// so it is typed loosely here — results are shaped via explicit casts below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function notifyCycle(supabase: any, resendApiKey: string, cycleId: string): Promise<{ sent: number; failed: number }> {
  // Cycle + academy context. A READ error must FAIL LOUD (throw) — the caller releases the claim
  // and the next tick retries. Swallowing it → {sent:0,failed:0} → the cycle stays permanently
  // claimed with its audience never notified (a silent drop). A genuinely missing cycle is a
  // legitimate no-op.
  const { data: cycle, error: cycleErr } = await supabase
    .from("cycles").select("id, name, owner_id, settings").eq("id", cycleId).maybeSingle();
  if (cycleErr) throw new Error(`member-open cycle read failed: ${cycleErr.message}`);
  if (!cycle) return { sent: 0, failed: 0 };
  const settings = (cycle.settings || {}) as Record<string, unknown>;
  const priorityPeople: string[] = Array.isArray(settings.rebook_priority_people)
    ? (settings.rebook_priority_people as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  // Accountless GUEST academy players granted priority — emailed the same "create account & book"
  // link; can_book_member_window clause (e) grants them once their guest row links by email.
  const priorityGuests: string[] = Array.isArray(settings.rebook_priority_guests)
    ? (settings.rebook_priority_guests as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const customMessage = typeof settings.rebook_member_open_message === "string" ? settings.rebook_member_open_message : "";
  // RB03: recipients already emailed in a prior (partial) run — skipped so a retry only
  // re-sends the ones that failed.
  const alreadyNotifiedKeys: string[] = Array.isArray(settings.rebook_member_open_notified_recipients)
    ? (settings.rebook_member_open_notified_recipients as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  // The round's slots (source_cycle_id = this cycle) → their pending-window claims. Fail loud: a
  // read error must NOT masquerade as "no slots" (→ permanent claim, unsent audience).
  // KEYSET-paginated by slot id (Codex round-7 #3): an unpaginated read caps at ~1000 slots — the
  // missing slots' claims never enter the audience, `failed` stays 0, and the cycle stays CLAIMED,
  // permanently suppressing those recipients (the exact silent drop this fn promises never to do).
  type SlotRow = { id: string; member_window_ends_at: string | null; academy_profile_id: string | null };
  const { rows: slots, error: slotsErr } = await fetchAllKeyset<SlotRow>(
    (after, limit) => {
      let q = supabase.from("availability_slots").select("id, member_window_ends_at, academy_profile_id").eq("source_cycle_id", cycleId);
      if (after) q = q.gt("id", after);
      return q.order("id").limit(limit);
    },
    (r) => r.id,
  );
  if (slotsErr) throw new Error(`member-open slots read failed: ${slotsErr.message}`);
  const slotIds = slots.map((s) => s.id);
  if (slotIds.length === 0) return { sent: 0, failed: 0 };
  const memberEnd = slots.map((s) => s.member_window_ends_at).filter((x): x is string => !!x).sort()[0] ?? null;
  const academyProfileId = slots.find((s) => s.academy_profile_id)?.academy_profile_id ?? cycle.owner_id;

  // KEYSET-paginated by claim id within each 200-slot batch (bounds the .in() list AND avoids a
  // >1000-row truncation — a batch of 200 slots can hold >1000 claims). Stable vs. concurrent status
  // changes (Codex round-7 #3).
  const { rows: claimsRaw, error: claimsErr } = await fetchAllInChunks<MemberOpenClaim & { id: string }>(
    slotIds,
    (slotChunk, after, limit) => {
      let q = supabase.from("slot_priority_claims").select("id, player_id, guest_player_id, status, response_intent").in("slot_id", slotChunk);
      if (after) q = q.gt("id", after);
      return q.order("id").limit(limit);
    },
    (r) => r.id,
  );
  if (claimsErr) throw new Error(`member-open claims read failed: ${claimsErr.message}`);
  const claims = claimsRaw as MemberOpenClaim[];

  const audience = computeMemberOpenAudience(claims, priorityPeople, priorityGuests, { alreadyNotifiedKeys });
  if (audience.length === 0) return { sent: 0, failed: 0 };

  // Resolve names + emails; drop anyone without a deliverable address. Contact-discovery reads fail
  // loud. Pure-profile recipients need only their profile; a GUEST's identity + account are resolved
  // from the guest's OWN verified relationships (person_links → twin → linked, split-freeze) via the
  // batch RPC that mirrors can_book_member_window — the claim's player_id is NOT proof of an account.
  const playerIds = audience.filter((a) => !a.guest_player_id).map((a) => a.player_id).filter((x): x is string => !!x);
  const guestIds = audience.map((a) => a.guest_player_id).filter((x): x is string => !!x);
  // CHUNKED + EXACT-SET (Codex round-6 #3): a large member-open audience (>1000 pure-profile players)
  // would truncate an un-chunked `.in("id", playerIds)` at ~1000 — the un-returned recipients then get
  // no email AND are never checkpointed, so the cycle stays CLAIMED and they are never re-sent (a
  // silent drop the fn explicitly promises never to do). Read in <=1000-id batches, fail loud, and
  // assert every requested profile id came back (a player_id always has a profiles row).
  const CHUNK = 1000;
  const profiles: Array<{ id: string; full_name: string | null; email: string | null }> = [];
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const { data, error } = await supabase.from("profiles").select("id, full_name, email").in("id", playerIds.slice(i, i + CHUNK));
    if (error) throw new Error(`member-open profiles read failed: ${error.message}`);
    profiles.push(...((data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>));
  }
  const returnedProfileIds = new Set(profiles.map((p) => p.id));
  const missingProfiles = playerIds.filter((id) => !returnedProfileIds.has(id));
  if (missingProfiles.length > 0) {
    throw new Error(`member-open profiles read incomplete: ${missingProfiles.length} of ${playerIds.length} profile(s) missing — refusing to drop them silently`);
  }
  const guestContacts: Array<{ guest_id: string; own_name: string | null; own_email: string | null; account_name: string | null; account_email: string | null; has_account: boolean }> = [];
  for (let i = 0; i < guestIds.length; i += CHUNK) {
    const { data, error } = await supabase.rpc("resolve_guest_member_contacts", { _guest_ids: guestIds.slice(i, i + CHUNK) });
    if (error) throw new Error(`member-open guest contact resolution failed: ${error.message}`);
    guestContacts.push(...((data ?? []) as typeof guestContacts));
  }
  const maps: MemberOpenContactMaps = {
    profileName: new Map(), profileEmail: new Map(),
    guestOwnName: new Map(), guestOwnEmail: new Map(), guestAccountName: new Map(), guestAccountEmail: new Map(), guestHasAccount: new Set(),
  };
  for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    maps.profileName.set(p.id, (p.full_name ?? "").trim());
    if (p.email?.trim()) maps.profileEmail.set(p.id, p.email.trim());
  }
  for (
    const g of (guestContacts ?? []) as Array<{ guest_id: string; own_name: string | null; own_email: string | null; account_name: string | null; account_email: string | null; has_account: boolean }>
  ) {
    if (g.own_name?.trim()) maps.guestOwnName.set(g.guest_id, g.own_name.trim());
    if (g.own_email?.trim()) maps.guestOwnEmail.set(g.guest_id, g.own_email.trim());
    if (g.account_name?.trim()) maps.guestAccountName.set(g.guest_id, g.account_name.trim());
    if (g.account_email?.trim()) maps.guestAccountEmail.set(g.guest_id, g.account_email.trim());
    if (g.has_account) maps.guestHasAccount.add(g.guest_id);
  }
  const recipients = audience
    .map((a) => {
      const key = recipientKey(a); // GUEST-FIRST canonical key (grouping + RB03 persistence)
      if (!key) return null;
      const contact = resolveMemberOpenContact(a, maps);
      // needsSignup: only a genuinely accountless guest gets the "create an account" CTA; a linked
      // guest / dual-key child / profile is account-backed and gets the direct book link instead.
      return contact ? { key, name: contact.name, email: contact.email, needsSignup: contact.needsSignup } : null;
    })
    .filter((r): r is { key: string; name: string; email: string; needsSignup: boolean } => !!r);
  if (recipients.length === 0) return { sent: 0, failed: 0 };

  // Academy slug + timezone for the deep-link + deadline formatting. Fail loud on a read error.
  const { data: academy, error: academyErr } = academyProfileId
    ? await supabase.from("academy_profiles").select("slug, timezone").eq("id", academyProfileId).maybeSingle()
    : { data: null, error: null };
  if (academyErr) throw new Error(`member-open academy read failed: ${academyErr.message}`);
  const slug = (academy as { slug?: string | null } | null)?.slug ?? null;
  const tz = (academy as { timezone?: string | null } | null)?.timezone || "Europe/Amsterdam";
  const bookUrl = slug ? `${APP_BASE}/nl/academies/${slug}?cycle=${cycleId}` : `${APP_BASE}/nl`;
  // R06: a guest (no login) can't book the member window until they complete an account.
  // link_guest_data_to_profile links them by email at signup, after which
  // can_book_member_window clause (d) recognises them — so guests get an account-completion
  // CTA (email + name pre-filled) instead of the bare booking link, which would dead-end.
  // redirect is /app/player (sanitizeAppRedirect only allows /app/ paths); the booking link
  // is offered as the "already have an account?" fallback below.
  const signupUrl = (name: string, email: string) => {
    const p = new URLSearchParams({ email, redirect: "/app/player" });
    if (name) p.set("name", name);
    return `${APP_BASE}/app/signup/player?${p.toString()}`;
  };
  const deadline = memberEnd
    ? new Date(memberEnd).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })
    : null;

  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    if (sent > 0 || failed > 0) await sleep(120);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color:#1a1a1a;">
        <h2 style="margin:0 0 12px;">Er zijn plekken vrijgekomen${cycle.name ? ` (${escapeHtml(String(cycle.name))})` : ""}</h2>
        <p style="color:#374151;line-height:1.6;">${r.name ? `Hi ${escapeHtml(r.name)},` : "Hi,"}</p>
        ${renderCustomMessage(customMessage, r.name)}
        <p style="color:#374151;line-height:1.6;">Er zijn plekken vrijgekomen voor de volgende ronde en jij mag als eerste boeken — vóór het publiek.</p>
        ${deadline ? `<p style="color:#6b7280;font-size:13px;">Je hebt voorrang tot <strong>${deadline}</strong>. Daarna komen de plekken vrij voor iedereen.</p>` : ""}
        ${r.needsSignup ? `
        <p style="color:#374151;line-height:1.6;">Maak eerst je account aan met dit e-mailadres, dan kun je je plek boeken.</p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${signupUrl(r.name, r.email)}" style="display:inline-block;background:#16a34a;color:white;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Account aanmaken &amp; plek boeken</a>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;">Heb je al een account? <a href="${bookUrl}" style="color:#f45d25;">Boek hier direct</a>.</p>
        ` : `
        <div style="text-align:center;margin:28px 0;">
          <a href="${bookUrl}" style="display:inline-block;background:#16a34a;color:white;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Bekijk vrije plekken</a>
        </div>
        <p style="color:#9ca3af;font-size:12px;text-align:center;">Of open deze link: <a href="${bookUrl}" style="color:#f45d25;">${bookUrl}</a></p>
        `}
      </div>`;
    // sendResendEmail returns { ok: false } on any send failure (it never throws for a send error)
    // and sets a deterministic Idempotency-Key header, so a retry after a timeout-post-accept — or a
    // whole-cycle retry — is de-duplicated by Resend within its window instead of double-sending.
    const outcome = await sendResendEmail(
      resendApiKey,
      { from: FROM, to: [r.email], subject: "Er zijn plekken vrijgekomen — jij mag als eerste boeken", html },
      { idempotencyKey: `member-open:${cycleId}:${r.key}` }, // deterministic per (cycle, recipient)
    );
    if (!outcome.ok) { failed++; console.error("member-open send error", outcome); continue; }
    sent++;
    // RB03 CHECKPOINT the recipient ATOMICALLY, right after their send — so a crash later in the loop
    // leaves them recorded and a retry never re-sends them. A checkpoint failure counts as `failed`
    // so the cycle is retried; the deterministic idempotency key makes that re-send a no-op.
    const { error: chkErr } = await supabase.rpc("append_rebook_member_open_notified", { _cycle_id: cycleId, _keys: [r.key] });
    if (chkErr) {
      failed++;
      await notifySlackEdgeError(
        "notify-rebook-member-open",
        "RB03 checkpoint failed for a sent recipient — cycle will retry (idempotent re-send)",
        { cycleId, error: String((chkErr as { message?: string })?.message ?? chkErr) },
      );
    }
  }

  return { sent, failed };
}

serve(handler);
