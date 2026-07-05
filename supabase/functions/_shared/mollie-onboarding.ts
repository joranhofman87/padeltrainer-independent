// Public-booking audit P1-3: mollie-callback used to hardcode onboarding_complete /
// charges_enabled / payouts_enabled = true the instant OAuth returned, so an account that had
// NOT finished Mollie KYC still showed "Ready for online payments" and its slots showed
// bookable — a guest then filled the whole form and Mollie 422'd ("method not activated").
//
// This resolves the stored readiness flags from Mollie's real onboarding resource
// (GET /v2/onboarding/me), used at connect (mollie-callback) and on reconcile
// (check-mollie-connect-status, so an account that finishes KYC after connecting self-heals).

export interface MollieReadiness {
  onboardingComplete: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

interface MollieOnboarding {
  // "needs-data" | "in-review" | "completed"
  status?: string | null;
  canReceivePayments?: boolean | null;
  canReceiveSettlements?: boolean | null;
}

/**
 * Pure mapping from Mollie's onboarding resource to our stored readiness flags.
 * `canReceivePayments` is the authoritative "can this account take a payment right now" signal
 * (charges_enabled); onboarding_complete tracks `status === 'completed'`; payouts track
 * `canReceiveSettlements`. Anything missing/false ⇒ not ready (conservative).
 */
export function deriveMollieReadiness(onboarding: MollieOnboarding | null | undefined): MollieReadiness {
  return {
    onboardingComplete: onboarding?.status === "completed",
    chargesEnabled: onboarding?.canReceivePayments === true,
    payoutsEnabled: onboarding?.canReceiveSettlements === true,
  };
}

/**
 * Fetch the connected account's real onboarding/KYC readiness from Mollie.
 * Returns null on ANY failure (network / non-2xx / parse) so callers can choose the safe
 * default — at connect: not ready; on reconcile: leave the stored flags unchanged (never
 * flap a working account to not-ready on a transient blip).
 */
export async function fetchMollieReadiness(accessToken: string): Promise<MollieReadiness | null> {
  try {
    const resp = await fetch("https://api.mollie.com/v2/onboarding/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const onboarding = (await resp.json()) as MollieOnboarding;
    return deriveMollieReadiness(onboarding);
  } catch (_) {
    return null;
  }
}
