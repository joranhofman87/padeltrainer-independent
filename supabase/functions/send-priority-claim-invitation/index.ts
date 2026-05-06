import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const APP_BASE = Deno.env.get("PUBLIC_APP_URL") || "https://padeltrainer.lovable.app";

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return new Response(JSON.stringify({ error: "email_not_configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const isService = token === serviceKey;
    if (!isService) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    const body = await req.json();
    const { claimIds, slotId, testEmail } = body as {
      claimIds?: string[];
      slotId?: string;
      testEmail?: string;
    };

    let query = supabase
      .from("slot_priority_claims")
      .select(
        "id, claim_token, status, slot_id, player_id, guest_player_id, profiles:player_id(full_name, email), guest_players:guest_player_id(full_name, email)"
      );
    if (claimIds && claimIds.length) query = query.in("id", claimIds);
    else if (slotId) query = query.eq("slot_id", slotId);
    else
      return new Response(JSON.stringify({ error: "claimIds or slotId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    const { data: claims, error: cErr } = await query;
    if (cErr) throw cErr;
    if (!claims || claims.length === 0)
      return new Response(JSON.stringify({ sent: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    // Fetch slot info for the first slot (assume all share or fetch per claim)
    const slotIds = [...new Set(claims.map((c: any) => c.slot_id))];
    const { data: slots } = await supabase
      .from("availability_slots")
      .select("id, start_time, end_time, cyclus_name, price_per_session, priority_window_ends_at")
      .in("id", slotIds);
    const slotMap = new Map((slots || []).map((s: any) => [s.id, s]));

    const resend = new Resend(resendApiKey);
    let sent = 0;

    for (const c of claims as any[]) {
      const slot = slotMap.get(c.slot_id);
      if (!slot) continue;
      const recipientEmail = testEmail || c.profiles?.email || c.guest_players?.email;
      if (!recipientEmail) continue;
      const recipientName = c.profiles?.full_name || c.guest_players?.full_name || "";

      const start = new Date(slot.start_time);
      const end = new Date(slot.end_time);
      const fmtDate = start.toLocaleDateString("nl-NL", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
      const fmtTime = `${start.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`;
      const claimUrl = `${APP_BASE}/claim/${c.claim_token}`;
      const deadline = slot.priority_window_ends_at
        ? new Date(slot.priority_window_ends_at).toLocaleDateString("nl-NL", { day: "numeric", month: "long" })
        : null;

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color:#1a1a1a;">
          <h2 style="margin:0 0 12px;">Reserveer je plek voor de volgende cyclus${slot.cyclus_name ? `: ${slot.cyclus_name}` : ""}</h2>
          <p style="color:#374151;line-height:1.6;">${recipientName ? `Hi ${recipientName},` : "Hi,"}</p>
          <p style="color:#374151;line-height:1.6;">Je hebt voorrang om je vaste plek opnieuw te boeken voor de volgende cyclus. Laat ons weten of je doorgaat.</p>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
            <div style="font-weight:600;">${fmtDate}</div>
            <div style="color:#6b7280;">${fmtTime}</div>
            ${slot.price_per_session ? `<div style="margin-top:6px;">EUR ${Number(slot.price_per_session).toFixed(2)} per sessie</div>` : ""}
          </div>
          ${deadline ? `<p style="color:#6b7280;font-size:13px;">Reageer voor <strong>${deadline}</strong>, daarna komt je plek vrij voor anderen.</p>` : ""}
          <div style="text-align:center;margin:28px 0;">
            <a href="${claimUrl}" style="display:inline-block;background:#f45d25;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;">Bekijk en reserveer</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;">Of open deze link: <a href="${claimUrl}" style="color:#f45d25;">${claimUrl}</a></p>
        </div>
      `;

      const { error: sendErr } = await resend.emails.send({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [recipientEmail],
        subject: testEmail ? "[TEST] Reserveer je plek voor de volgende cyclus" : "Reserveer je plek voor de volgende cyclus",
        html,
      });
      if (sendErr) {
        console.error("send error", sendErr);
        continue;
      }
      sent++;
      if (!testEmail) {
        await supabase
          .from("slot_priority_claims")
          .update({ invited_at: new Date().toISOString() })
          .eq("id", c.id);
      }
    }

    return new Response(JSON.stringify({ sent }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
};

serve(handler);
