// Academy manager sends an ad-hoc reminder email to SELECTED players of one rebook
// cycle (e.g. "please confirm your spot"). Constrained: a plain-text subject + body
// the academy types; we escape it and wrap it in the branded shell with a CTA to the
// player's claim link. Never free HTML.
//
// Security: the caller must MANAGE the cycle (verified via RLS on availability_slots
// under their JWT), and we only email players who actually hold a claim in THIS cycle
// (targets are re-validated against the cycle's claims — no arbitrary recipients).
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { buildClaimUrl, effectiveGuestEmail, resolveAppBase, resolveRecipient } from "../_shared/priority-claim-invite.ts";
import { personKeyOf, personRefOf, personDisplayName } from "../_shared/person-identity.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));
const BRAND = "#f45d25";
const MAX_RECIPIENTS = 200;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Personalization tokens — same set the rebook invite + invoice emails use, so a reminder
// pre-filled from the saved invite text renders {first_name} etc. instead of showing them raw.
// Substitute BEFORE escaping (the per-line escape below covers both the academy text and the
// substituted name).
const substituteVars = (text: string, fullName: string) => {
  const full = (fullName || "").trim();
  const first = full.split(/\s+/)[0] || full;
  const last = full.includes(" ") ? full.slice(full.indexOf(" ") + 1).trim() : "";
  return text
    .replace(/\{first_name\}/g, first)
    .replace(/\{last_name\}/g, last)
    .replace(/\{full_name\}/g, full);
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Authentication required" }, 401);
    if (!resendKey) return json({ ok: false, reason: "email_not_configured" }, 200);

    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ ok: false, error: "Unauthorized" }, 401);

    const { cycleId, targets, subject, message } = await req.json();
    const subj = typeof subject === "string" ? subject.trim().slice(0, 120) : "";
    const msg = typeof message === "string" ? message.trim().slice(0, 2000) : "";
    const targetList: Array<{ player_id: string | null; guest_player_id: string | null }> =
      Array.isArray(targets) ? targets : [];
    if (!cycleId || !subj || !msg || targetList.length === 0) {
      return json({ ok: false, error: "cycleId, subject, message and targets are required" }, 400);
    }
    // GUEST-FIRST canonical person keys (FAM-02): a dual-key target belongs to the GUEST, so it
    // keys g:<guest> — never the linked parent's p:<player>. Must match the claim keying below.
    const targetKeys = new Set(
      targetList.map((t) => personKeyOf(t)).filter((k): k is string => !!k),
    );

    // Authorize: the caller must MANAGE this cycle's academy. Do NOT infer ownership from
    // availability_slots — those are publicly readable (is_public=true), so an RLS-empty
    // check there would let any logged-in user email another academy's players. Verify the
    // academy_managers link explicitly (same gate as bulk-rebook-cycle).
    const { data: cycle } = await supabase
      .from("cycles").select("name, owner_id, owner_type").eq("id", cycleId).maybeSingle();
    if (!cycle || cycle.owner_type !== "academy" || !cycle.owner_id) return json({ ok: false, error: "Forbidden" }, 403);
    const { data: mgr } = await supabase
      .from("academy_managers").select("user_id")
      .eq("academy_profile_id", cycle.owner_id).eq("user_id", user.id).maybeSingle();
    if (!mgr) return json({ ok: false, error: "Forbidden" }, 403);

    const { data: slotRows, error: slotErr } = await supabase.from("availability_slots").select("id").eq("cyclus_id", cycleId);
    if (slotErr) throw new Error(`slot read failed: ${slotErr.message}`); // fail loud — not a zero-send success
    const slotIds = (slotRows ?? []).map((s: { id: string }) => s.id);
    if (slotIds.length === 0) return json({ ok: true, sent: 0, skipped: 0, failed: 0 });

    const { data: acad } = await supabase.from("academy_profiles").select("name").eq("id", cycle.owner_id).maybeSingle();
    const academyName = acad?.name ?? "";

    // Resolve recipients from THIS cycle's claims, scoped to the requested targets, one per
    // player. Exclude declined/expired claims — a reminder must never re-ping someone who
    // already opted out (only pending and claimed players get one).
    const { data: claims, error: claimsErr } = await supabase
      .from("slot_priority_claims")
      .select("claim_token, player_id, guest_player_id, profiles:player_id(full_name, email), guest_players:guest_player_id(full_name, email, linked_profile:linked_profile_id(email))")
      .in("slot_id", slotIds)
      .in("status", ["pending", "claimed"]);
    if (claimsErr) throw new Error(`claims read failed: ${claimsErr.message}`); // fail loud — else we'd silently reach nobody
    type ClaimRow = {
      claim_token: string;
      player_id: string | null;
      guest_player_id: string | null;
      profiles: { full_name: string | null; email: string | null } | null;
      guest_players: { full_name: string | null; email: string | null; linked_profile: { email: string | null } | null } | null;
    };
    const byPlayer = new Map<string, ClaimRow>();
    // PostgREST types the to-one embeds (incl. the nested linked_profile) as arrays; the
    // runtime values are single objects — cast through unknown (same idiom as the invite fn).
    // Dedup GUEST-FIRST: a dual-key child (g:<guest>) and their linked parent (p:<player>) are
    // DISTINCT people — the old player-first key collapsed both under p:<player>, so only one of
    // them got a reminder.
    for (const c of (claims ?? []) as unknown as ClaimRow[]) {
      const key = personKeyOf(c);
      if (!key || !targetKeys.has(key) || byPlayer.has(key)) continue;
      byPlayer.set(key, c);
    }

    const recipients = [...byPlayer.values()].slice(0, MAX_RECIPIENTS);
    const resend = new Resend(resendKey);
    let sent = 0, skipped = 0, failed = 0;
    // Player/guest ids that actually received a reminder — used to stamp reminded_at after the loop.
    const sentPlayerIds: string[] = [];
    const sentGuestIds: string[] = [];

    for (const c of recipients) {
      const email = resolveRecipient({
        isTest: false, callerEmail: null,
        // GUEST-FIRST, keyed on the row's ids (FAM-02): a dual-key child is reached at their OWN
        // email; the linked profile's address is the fallback ONLY when the guest has none
        // (effectiveGuestEmail already does guest.email ?? linked_profile.email).
        row: { player_id: c.player_id, guest_player_id: c.guest_player_id },
        playerEmail: c.profiles?.email, guestEmail: effectiveGuestEmail(c.guest_players),
      });
      if (!email) { skipped++; continue; }
      // GUEST-FIRST name (FAM-02): a dual-key child shows their OWN name; the linked profile name
      // is only the blank-name fallback for a guest.
      const name = personDisplayName(c, { profileName: c.profiles?.full_name, guestName: c.guest_players?.full_name }, "");
      const cta = buildClaimUrl(APP_BASE, c.claim_token, false);
      const body = substituteVars(msg, name).split("\n").map((line) => `<p style="color:#374151;line-height:1.6;">${escapeHtml(line)}</p>`).join("");
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          ${cycle?.name ? `<h2 style="color:${BRAND};">${escapeHtml(cycle.name)}</h2>` : ""}
          <p>Hi ${escapeHtml(name)},</p>
          ${body}
          <div style="text-align:center;margin:28px 0;">
            <a href="${cta}" style="display:inline-block;background:${BRAND};color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Bekijk je uitnodiging</a>
          </div>
          <p style="color:#6b7280;font-size:13px;">Of open deze link: <a href="${cta}" style="color:${BRAND};">${cta}</a></p>
          <p style="color:#9ca3af;font-size:12px;">${escapeHtml(academyName)}</p>
        </div>`;
      const { error: sendErr } = await resend.emails.send({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [email],
        subject: subj,
        html,
      });
      if (sendErr) { console.error("send error", sendErr); failed++; continue; }
      sent++;
      // GUEST-FIRST stamp routing (FAM-02): a dual-key child is stamped as the GUEST, never the
      // parent's player_id — otherwise bump_rebook_reminders marks the parent (and every claim
      // sharing that player_id) reminded. personRefOf picks the guest id on a dual-key row.
      const ref = personRefOf(c);
      if (ref?.guestPlayerId) sentGuestIds.push(ref.guestPlayerId);
      else if (ref?.playerId) sentPlayerIds.push(ref.playerId);
    }

    // Stamp reminded_at + bump reminder_count on the claims we actually emailed (atomic RPC;
    // best-effort — the emails already went out, so a stamp failure must not fail the response).
    if (sentPlayerIds.length > 0 || sentGuestIds.length > 0) {
      const { error: stampErr } = await supabase.rpc("bump_rebook_reminders", {
        p_slot_ids: slotIds,
        p_player_ids: sentPlayerIds,
        p_guest_ids: sentGuestIds,
      });
      if (stampErr) {
        console.error("reminded_at stamp failed", stampErr);
        // Non-blocking: emails already sent, but a failed stamp means these players can be re-reminded.
        await notifySlackEdgeError("send-rebook-reminder", "reminded_at stamp failed (players may be re-reminded)", { cycleId, sentPlayers: sentPlayerIds.length, sentGuests: sentGuestIds.length, error: String(stampErr?.message ?? stampErr) });
      }
    }

    // Aggregate alert for per-recipient send failures (never per-item) before the 200 response.
    if (failed > 0) {
      await notifySlackEdgeError("send-rebook-reminder", `${failed} of ${recipients.length} reminder emails failed`, { cycleId, sent, skipped, failed, recipients: recipients.length });
    }

    return json({ ok: true, sent, skipped, failed });
  } catch (e) {
    // Unexpected failure (auth/DB/parse) — surface to Slack before the 500.
    await notifySlackEdgeError("send-rebook-reminder", String((e as Error)?.message ?? e));
    return json({ ok: false, error: "internal_error", message: String((e as Error)?.message ?? e) }, 500);
  }
});
