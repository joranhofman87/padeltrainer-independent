// Anonymous, login-free READ of a guest booking's state by its public_token, for
// the /booking/:token confirmation page a guest lands on after paying. Mirrors the
// get-public-invoice anon pattern. verify-mollie-payment is auth-only and refuses
// guests, so this reads through the SECURITY DEFINER get_guest_booking_by_token RPC
// (service_role) and returns only what the confirmation screen needs — the booking
// state + slot time + amount, never PII or the mollie_payment_id. The mollie-webhook
// commits the paid hold; this endpoint just reports state (the page polls while
// pending). No side effects.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeadersFor } from "../_shared/cors.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  const corsHeaders = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return json({ error: "token_required" }, 400);
    // The column is uuid — a non-uuid would error the RPC; treat it as not-found.
    if (!UUID_RE.test(token)) return json({ error: "not_found" }, 404);

    const { data, error } = await supabase.rpc("get_guest_booking_by_token", { _token: token });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { payment_status: string | null; status: string | null; start_time: string; end_time: string; cyclus_name: string | null; payment_amount: number | null; hold_expires_at: string | null; session_count: number | null }
      | undefined;
    if (!row) return json({ error: "not_found" }, 404);

    const paid = row.payment_status === "paid";
    const expiredUnpaid = !paid && !!row.hold_expires_at && new Date(row.hold_expires_at).getTime() < Date.now();
    const status = paid ? "confirmed" : (row.status === "cancelled" || expiredUnpaid ? "cancelled" : "pending");

    return json({
      status,
      slotStart: row.start_time,
      slotEnd: row.end_time,
      cyclusName: row.cyclus_name ?? null,
      amount: row.payment_amount != null ? Number(row.payment_amount) : null,
      sessionCount: row.session_count != null ? Number(row.session_count) : 1,
    });
  } catch (_error) {
    return json({ error: "server_error" }, 500);
  }
});
