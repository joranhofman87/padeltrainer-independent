// Shared money-path helpers for the anonymous guest pay-first flows (single-slot +
// whole-cyclus). Extracted so BOTH flows resolve the charging recipient with the
// EXACT same predicate — the org that charges must equal the org the mollie-webhook
// later uses to confirm the paid hold, or the payment strands. Duplicating this was
// the P1 that adversarial review caught for the single-slot fn; sharing it makes the
// invariant structural.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export type MollieRecipient = {
  accessToken: string | null;
  recipientType: "academy" | "trainer" | null;
  mollieOrgId: string | null;
  platformFee: number;
};

// Refresh a connected account's OAuth token if it's within 5 min of expiry; fails
// safe to the old token on any error so a transient hiccup never blocks a payment.
export async function refreshTokenIfNeeded(
  supabase: SupabaseClient,
  account: { access_token: string | null; refresh_token?: string | null; token_expires_at?: string | null },
  entityType: "trainer" | "academy",
  entityId: string,
): Promise<string | null> {
  const clientId = Deno.env.get("MOLLIE_CLIENT_ID");
  const clientSecret = Deno.env.get("MOLLIE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return account.access_token;
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;
  if (expiresAt && expiresAt > new Date(Date.now() + 5 * 60 * 1000)) return account.access_token;
  if (!account.refresh_token) return account.access_token;
  try {
    const resp = await fetch("https://api.mollie.com/oauth2/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refresh_token }),
    });
    if (!resp.ok) return account.access_token;
    const tokens = await resp.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const table = entityType === "trainer" ? "trainer_mollie_accounts" : "academy_mollie_accounts";
    const idCol = entityType === "trainer" ? "trainer_id" : "academy_profile_id";
    await supabase.from(table).update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    }).eq(idCol, entityId);
    return tokens.access_token;
  } catch {
    return account.access_token;
  }
}

// Flat platform fee for a tier's plan (academy €0.50 / trainer starter|professional).
export async function tierFlat(supabase: SupabaseClient, tier: string): Promise<number | null> {
  const { data: plan } = await supabase
    .from("subscription_plans")
    .select("platform_fee_flat")
    .eq("tier", tier)
    .eq("plan_type", "trainer")
    .eq("is_active", true)
    .maybeSingle();
  return plan?.platform_fee_flat != null ? Number(plan.platform_fee_flat) : null;
}

// Resolve the charging recipient the SAME way mollie-webhook.resolveAccessToken +
// create-mollie-payment do: the slot's trainer -> their ACTIVE academy membership
// -> that academy's Mollie, else the trainer's OWN Mollie. Keyed off the slot's
// trainer_id (never client input). Using the identical predicate to the webhook is
// load-bearing: the org that CHARGES here must equal the org that later CONFIRMS the
// paid hold. (Do NOT route by slot.academy_profile_id — the webhook's booking branch
// never reads it.)
export async function resolveSlotRecipient(
  supabase: SupabaseClient,
  trainerProfileId: string,
): Promise<MollieRecipient> {
  let accessToken: string | null = null;
  let recipientType: "academy" | "trainer" | null = null;
  let mollieOrgId: string | null = null;
  let platformFee = 1.0;

  const { data: academyTrainer } = await supabase
    .from("academy_trainers")
    .select("academy_profile_id, academy:academy_profiles(id, platform_fee_override)")
    .eq("trainer_profile_id", trainerProfileId)
    .eq("status", "active")
    .maybeSingle();

  if (academyTrainer?.academy_profile_id) {
    const { data: academyMollie } = await supabase
      .from("academy_mollie_accounts")
      .select("mollie_organization_id, charges_enabled, access_token, refresh_token, token_expires_at")
      .eq("academy_profile_id", academyTrainer.academy_profile_id)
      .eq("onboarding_complete", true)
      .maybeSingle();
    if (academyMollie?.access_token && academyMollie?.charges_enabled) {
      accessToken = await refreshTokenIfNeeded(supabase, academyMollie, "academy", academyTrainer.academy_profile_id);
      recipientType = "academy";
      mollieOrgId = academyMollie.mollie_organization_id ?? null;
      const academy = academyTrainer.academy as { platform_fee_override?: number | null } | null;
      platformFee = academy?.platform_fee_override != null
        ? Number(academy.platform_fee_override)
        : ((await tierFlat(supabase, "academy")) ?? 1.0);
    }
  }

  if (!accessToken) {
    const { data: trainerMollie } = await supabase
      .from("trainer_mollie_accounts")
      .select("mollie_organization_id, access_token, refresh_token, token_expires_at")
      .eq("trainer_id", trainerProfileId)
      .eq("onboarding_complete", true)
      .maybeSingle();
    if (trainerMollie?.access_token) {
      accessToken = await refreshTokenIfNeeded(supabase, trainerMollie, "trainer", trainerProfileId);
      recipientType = "trainer";
      mollieOrgId = trainerMollie.mollie_organization_id ?? null;
      const { data: tp } = await supabase
        .from("trainer_profiles").select("platform_fee_override, subscription_status").eq("id", trainerProfileId).maybeSingle();
      platformFee = tp?.platform_fee_override != null
        ? Number(tp.platform_fee_override)
        : ((await tierFlat(supabase, tp?.subscription_status === "active" ? "professional" : "starter")) ?? 1.0);
    }
  }

  return { accessToken, recipientType, mollieOrgId, platformFee };
}

// Best-effort per-key throttle on the shared rate_limits table. Fails OPEN so a DB
// hiccup never blocks a real booking. Returns true when allowed.
export async function throttleGuestPayment(
  supabase: SupabaseClient,
  endpoint: string,
  identifier: string,
  max: number,
  windowMin: number,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMin * 60 * 1000);
  try {
    const { data: existing } = await supabase
      .from("rate_limits").select("id, request_count, window_start")
      .eq("identifier", identifier).eq("endpoint", endpoint).maybeSingle();
    if (existing && new Date(existing.window_start) > windowStart) {
      if (existing.request_count >= max) return false;
      await supabase.from("rate_limits").update({ request_count: existing.request_count + 1 }).eq("id", existing.id);
      return true;
    }
    await supabase.from("rate_limits").upsert(
      { identifier, endpoint, request_count: 1, window_start: new Date().toISOString() },
      { onConflict: "identifier,endpoint" },
    );
    return true;
  } catch (_err) {
    return true; // fail open
  }
}

// Best-effort release of uncommitted holds on any post-hold failure. Guarded on
// status='payment_pending' so a hold the webhook already committed is never
// cancelled; payment_status is left untouched so a late webhook still hits the
// paid-on-cancelled refund alert. Swallows errors — the TTL sweep is the backstop.
export async function softCancelGuestHolds(supabase: SupabaseClient, bookingIds: string[]): Promise<void> {
  if (!bookingIds.length) return;
  try {
    await supabase.from("bookings").update({ status: "cancelled" })
      .in("id", bookingIds).eq("status", "payment_pending");
  } catch (_) {
    // TTL sweep (release_expired_guest_slot_holds) reclaims these.
  }
}

/** Distribute a total (euros) across n bookings in whole cents; sums back to total. */
export function distributeAmountCents(totalEuros: number, n: number): number[] {
  if (n <= 0) return [];
  const totalCents = Math.round(totalEuros * 100);
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}
