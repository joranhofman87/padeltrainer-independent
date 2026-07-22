import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { resolveAppBase } from "../_shared/priority-claim-invite.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { computeMemberOpenAudience, recipientKey, resolveMemberOpenContact, type MemberOpenClaim } from "../_shared/rebook-member-open.ts";

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

async function sendWithRetry(
  resend: Resend,
  payload: { from: string; to: string[]; subject: string; html: string },
  maxAttempts = 4,
): Promise<{ error: unknown | null }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { error } = await resend.emails.send(payload);
    if (!error) return { error: null };
    lastError = error;
    const e = error as { statusCode?: number; name?: string };
    const isRateLimit = e?.statusCode === 429 || e?.name === "rate_limit_exceeded" ||
      (e?.statusCode == null && /\b429\b|rate.?limit/i.test(JSON.stringify(error ?? {})));
    if (!isRateLimit) return { error };
    if (attempt < maxAttempts - 1) await sleep(800 * (attempt + 1));
  }
  return { error: lastError };
}

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
  const resend = new Resend(resendApiKey);

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
    const { data: dueRows } = await supabase.from("cycles").select("id, settings").in("id", cycleIds);
    const roundOf = new Map<string, string | null>();
    for (const r of dueRows ?? []) {
      roundOf.set(r.id, ((r.settings as Record<string, unknown> | null)?.rebook_round_id as string | undefined) ?? null);
    }
    const seenRounds = new Set<string>();
    const roundAlreadyNotified = async (round: string, selfId: string): Promise<boolean> => {
      const { data } = await supabase.from("cycles").select("id")
        .eq("settings->>rebook_round_id", round)
        .neq("id", selfId)
        .not("settings->>rebook_member_open_notified_at", "is", null)
        .limit(1);
      return (data ?? []).length > 0;
    };

    for (const cycleId of cycleIds) {
      // Atomic claim: stamp notified_at IF NULL. Lost race ⇒ another run has it. The
      // claim serializes this round so the per-recipient bookkeeping below is race-free.
      const { data: claimed } = await supabase.rpc("claim_rebook_member_open_notice", { _cycle_id: cycleId });
      if (claimed !== true) continue;

      const round = roundOf.get(cycleId) ?? null;
      if (round && (seenRounds.has(round) || (await roundAlreadyNotified(round, cycleId)))) {
        // Sibling of an already-notified round: keep the claim stamped, send nothing.
        cyclesProcessed += 1;
        continue;
      }
      if (round) seenRounds.add(round);

      try {
        const { sent, failed } = await notifyCycle(supabase, resend, cycleId);
        totalSent += sent;
        cyclesProcessed += 1;
        if (failed > 0) {
          // Partial OR total failure → release the marker so the next tick re-detects the
          // round. Successful recipients are already recorded in settings, so the retry
          // re-sends ONLY the ones that failed (no duplicate to a successful recipient).
          await supabase.rpc("unclaim_rebook_member_open_notice", { _cycle_id: cycleId });
          await notifySlackEdgeError("notify-rebook-member-open", `partial send: ${sent} ok, ${failed} failed`, { cycleId });
        }
      } catch (e) {
        // Unexpected error (e.g. a DB read) → release the marker so the next tick retries.
        await supabase.rpc("unclaim_rebook_member_open_notice", { _cycle_id: cycleId });
        await notifySlackEdgeError("notify-rebook-member-open", e instanceof Error ? e.message : String(e), { cycleId });
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
async function notifyCycle(supabase: any, resend: Resend, cycleId: string): Promise<{ sent: number; failed: number }> {
  // Cycle + academy context.
  const { data: cycle } = await supabase
    .from("cycles").select("id, name, owner_id, settings").eq("id", cycleId).maybeSingle();
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

  // The round's slots (source_cycle_id = this cycle) → their pending-window claims.
  const { data: slots } = await supabase
    .from("availability_slots").select("id, member_window_ends_at, academy_profile_id").eq("source_cycle_id", cycleId);
  const slotIds = ((slots ?? []) as Array<{ id: string }>).map((s) => s.id);
  if (slotIds.length === 0) return { sent: 0, failed: 0 };
  const memberEnd = ((slots ?? []) as Array<{ member_window_ends_at: string | null }>)
    .map((s) => s.member_window_ends_at).filter((x): x is string => !!x).sort()[0] ?? null;
  const academyProfileId = ((slots ?? []) as Array<{ academy_profile_id: string | null }>)
    .find((s) => s.academy_profile_id)?.academy_profile_id ?? cycle.owner_id;

  const claims: MemberOpenClaim[] = [];
  for (let i = 0; i < slotIds.length; i += 200) {
    const { data: rows } = await supabase
      .from("slot_priority_claims")
      .select("player_id, guest_player_id, status, response_intent")
      .in("slot_id", slotIds.slice(i, i + 200));
    claims.push(...((rows ?? []) as MemberOpenClaim[]));
  }

  const audience = computeMemberOpenAudience(claims, priorityPeople, priorityGuests, { alreadyNotifiedKeys });
  if (audience.length === 0) return { sent: 0, failed: 0 };

  // Resolve names + emails; drop anyone without an email.
  const playerIds = audience.map((a) => a.player_id).filter((x): x is string => !!x);
  const guestIds = audience.map((a) => a.guest_player_id).filter((x): x is string => !!x);
  const [{ data: profiles }, { data: guests }] = await Promise.all([
    playerIds.length ? supabase.from("profiles").select("id, full_name, email").in("id", playerIds) : Promise.resolve({ data: [] }),
    guestIds.length ? supabase.from("guest_players").select("id, full_name, email").in("id", guestIds) : Promise.resolve({ data: [] }),
  ]);
  // Split name/email so a dual-key child WITHOUT their own email still keeps their OWN name while
  // falling back to the linked parent's inbox (names are populated regardless of email presence).
  const nameByKey = new Map<string, string>();
  const emailByKey = new Map<string, string>();
  for (const p of (profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    nameByKey.set(p.id, (p.full_name ?? "").trim());
    if (p.email?.trim()) emailByKey.set(p.id, p.email.trim());
  }
  for (const g of (guests ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    nameByKey.set(`g:${g.id}`, (g.full_name ?? "").trim());
    if (g.email?.trim()) emailByKey.set(`g:${g.id}`, g.email.trim());
  }
  const recipients = audience
    .map((a) => {
      const key = recipientKey(a); // GUEST-FIRST canonical key (grouping + RB03 persistence)
      if (!key) return null;
      // GUEST-FIRST (FAM-02): the guest's own name/email wins; the linked profile (via player_id) is
      // the fallback ONLY when the guest has none. A dual-key child is a guest → account CTA.
      const contact = resolveMemberOpenContact(a, nameByKey, emailByKey);
      return contact ? { key, name: contact.name, email: contact.email, isGuest: !!a.guest_player_id } : null;
    })
    .filter((r): r is { key: string; name: string; email: string; isGuest: boolean } => !!r);
  if (recipients.length === 0) return { sent: 0, failed: 0 };

  // Academy slug + timezone for the deep-link + deadline formatting.
  const { data: academy } = academyProfileId
    ? await supabase.from("academy_profiles").select("slug, timezone").eq("id", academyProfileId).maybeSingle()
    : { data: null };
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
  const newlyNotified: string[] = [];
  for (const r of recipients) {
    if (sent > 0 || failed > 0) await sleep(120);
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color:#1a1a1a;">
        <h2 style="margin:0 0 12px;">Er zijn plekken vrijgekomen${cycle.name ? ` (${escapeHtml(String(cycle.name))})` : ""}</h2>
        <p style="color:#374151;line-height:1.6;">${r.name ? `Hi ${escapeHtml(r.name)},` : "Hi,"}</p>
        ${renderCustomMessage(customMessage, r.name)}
        <p style="color:#374151;line-height:1.6;">Er zijn plekken vrijgekomen voor de volgende ronde en jij mag als eerste boeken — vóór het publiek.</p>
        ${deadline ? `<p style="color:#6b7280;font-size:13px;">Je hebt voorrang tot <strong>${deadline}</strong>. Daarna komen de plekken vrij voor iedereen.</p>` : ""}
        ${r.isGuest ? `
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
    const { error } = await sendWithRetry(resend, {
      from: FROM,
      to: [r.email],
      subject: "Er zijn plekken vrijgekomen — jij mag als eerste boeken",
      html,
    });
    if (error) { failed++; console.error("member-open send error", error); } else { sent++; newlyNotified.push(r.key); }
  }

  // RB03: record who was successfully emailed so a retry (below, on any failure) skips
  // them. Re-read settings right before writing to minimize clobbering a concurrent
  // academy edit; the atomic claim already serializes concurrent notifier runs.
  if (newlyNotified.length > 0) {
    const { data: fresh } = await supabase.from("cycles").select("settings").eq("id", cycleId).maybeSingle();
    const freshSettings = ((fresh?.settings as Record<string, unknown>) || settings) as Record<string, unknown>;
    const prior: string[] = Array.isArray(freshSettings.rebook_member_open_notified_recipients)
      ? (freshSettings.rebook_member_open_notified_recipients as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const merged = [...new Set([...prior, ...newlyNotified])];
    const { error: persistErr } = await supabase
      .from("cycles")
      .update({ settings: { ...freshSettings, rebook_member_open_notified_recipients: merged } })
      .eq("id", cycleId);
    if (persistErr) console.error("member-open persist notified recipients error", persistErr);
  }

  return { sent, failed };
}

serve(handler);
