import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_LEN = 500;

const sanitize = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_LEN);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json();
    const publicToken = typeof body?.publicToken === "string" ? body.publicToken : null;
    if (!publicToken) {
      return new Response(JSON.stringify({ error: "publicToken required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invoice, error: fetchErr } = await supabase
      .from("invoices")
      .select("id, status, player_id, guest_player_id, public_token_revoked_at")
      .eq("public_token", publicToken)
      .maybeSingle();

    if (fetchErr || !invoice || invoice.public_token_revoked_at) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (invoice.status === "paid" || invoice.status === "cancelled") {
      return new Response(JSON.stringify({ error: "invoice_locked" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const playerBusinessName = sanitize(body?.playerBusinessName);
    const playerAddress = sanitize(body?.playerAddress);
    const playerBtwNumber = sanitize(body?.playerBtwNumber);

    const updates = {
      player_business_name: playerBusinessName,
      player_address: playerAddress,
      player_btw_number: playerBtwNumber,
    };

    const { error: updErr } = await supabase
      .from("invoices")
      .update(updates)
      .eq("id", invoice.id);

    if (updErr) {
      return new Response(JSON.stringify({ error: "update_failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Persist billing details back to the player's profile / guest record
    // so future invoices for this recipient are pre-filled. Most-recent edit wins.
    const billingUpdates = {
      billing_business_name: playerBusinessName,
      billing_address: playerAddress,
      billing_btw_number: playerBtwNumber,
    };

    if (invoice.player_id) {
      await supabase
        .from("profiles")
        .update(billingUpdates)
        .eq("id", invoice.player_id);
    } else if (invoice.guest_player_id) {
      await supabase
        .from("guest_players")
        .update(billingUpdates)
        .eq("id", invoice.guest_player_id);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    // Log full detail server-side; never echo raw DB error text to callers.
    console.error("update-public-invoice-details error:", e);
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
