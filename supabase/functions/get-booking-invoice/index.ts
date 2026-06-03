import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeaders, requireUser } from "../_shared/auth.ts";

const log = (step: string, details?: Record<string, unknown>) =>
  console.log(`[GET-BOOKING-INVOICE] ${step}`, details ? JSON.stringify(details) : "");

type BookingRow = {
  id: string;
  payment_status: string;
  player_id: string | null;
  availability_slots: { trainer_id: string; academy_profile_id: string | null } | null;
};

async function canAccessBooking(
  supabase: SupabaseClient,
  userId: string,
  booking: BookingRow,
): Promise<boolean> {
  const slot = booking.availability_slots;
  if (!slot) return false;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (profile?.id && booking.player_id === profile.id) {
    return true;
  }

  const { data: trainerProfile } = await supabase
    .from("trainer_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (trainerProfile?.id === slot.trainer_id) {
    return true;
  }

  if (slot.academy_profile_id) {
    const { data: manager } = await supabase
      .from("academy_managers")
      .select("id")
      .eq("user_id", userId)
      .eq("academy_profile_id", slot.academy_profile_id)
      .maybeSingle();
    if (manager) return true;
  }

  const { data: adminRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  return !!adminRole;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authResult = await requireUser(req);
    if (authResult instanceof Response) return authResult;

    const { supabase, user, isServiceRole } = authResult;

    const { bookingId } = await req.json();
    if (!bookingId || typeof bookingId !== "string") {
      return new Response(JSON.stringify({ error: "Missing bookingId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: booking, error: bookingErr } = await supabase
      .from("bookings")
      .select("id, payment_status, player_id, availability_slots(trainer_id, academy_profile_id)")
      .eq("id", bookingId)
      .maybeSingle();

    if (bookingErr || !booking) {
      log("Booking not found", { bookingId, err: bookingErr?.message });
      return new Response(JSON.stringify({ error: "Booking not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!isServiceRole) {
      const allowed = await canAccessBooking(supabase, user.id, booking as BookingRow);
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (booking.payment_status !== "paid") {
      return new Response(JSON.stringify({ error: "Booking not paid", ready: false }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: invoices, error: invErr } = await supabase
      .from("invoices")
      .select("id, invoice_number, pdf_url, status")
      .contains("booking_ids", [bookingId])
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(1);

    if (invErr) {
      log("Invoice lookup failed", { err: invErr.message });
      return new Response(JSON.stringify({ error: "Invoice lookup failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const invoice = invoices?.[0];
    if (!invoice) {
      return new Response(JSON.stringify({ ready: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const { data: genData, error: genErr } = await supabase.functions.invoke("generate-invoice", {
      body: { invoiceId: invoice.id },
      headers: { Authorization: `Bearer ${serviceKey}` },
    });

    if (genErr || !genData?.pdfUrl) {
      log("generate-invoice failed", { err: genErr?.message, hasPdf: !!genData?.pdfUrl });
      if (invoice.pdf_url) {
        return new Response(
          JSON.stringify({
            ready: true,
            pdfUrl: invoice.pdf_url,
            invoiceNumber: invoice.invoice_number,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "Failed to generate invoice PDF" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        ready: true,
        pdfUrl: genData.pdfUrl,
        invoiceNumber: invoice.invoice_number,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("ERROR", { message });
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
