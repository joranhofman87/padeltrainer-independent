import { supabase } from '@/lib/supabaseClient';
import { isInvoiceSettingsComplete } from '@/lib/invoiceSettingsComplete';

export interface UpfrontEligibility {
  /** Either online (Mollie) or manual (invoice) payment can collect an upfront rebook. */
  canCharge: boolean;
  /** Mollie is connected → players check out online. */
  mollieReady: boolean;
  /** Invoice business profile is complete → players pay by bank transfer on the invoice. */
  invoiceReady: boolean;
}

/**
 * Read the academy's Mollie readiness for gating online checkout. `mollieReady` requires BOTH
 * charges_enabled AND onboarding_complete — mirroring the server (getAcademyMolliePaymentReadiness),
 * which won't open a checkout on a not-fully-onboarded account. Falls back to charges_enabled only
 * when the view hasn't been widened yet (frontend deployed before the onboarding_complete migration),
 * so we degrade to the old charges-only gate rather than hiding "pay directly" for every academy.
 */
async function fetchMollieReadiness(
  academyProfileId: string,
): Promise<{ chargesEnabled: boolean; onboardingComplete: boolean }> {
  const full = await supabase
    .from('academy_mollie_status' as never)
    .select('charges_enabled, onboarding_complete')
    .eq('academy_profile_id', academyProfileId)
    .maybeSingle();
  if (!full.error) {
    const row = full.data as { charges_enabled?: boolean; onboarding_complete?: boolean } | null;
    return { chargesEnabled: Boolean(row?.charges_enabled), onboardingComplete: Boolean(row?.onboarding_complete) };
  }
  // Pre-migration view (no onboarding_complete column) → charges-only, old behaviour.
  const basic = await supabase
    .from('academy_mollie_status' as never)
    .select('charges_enabled')
    .eq('academy_profile_id', academyProfileId)
    .maybeSingle();
  return {
    chargesEnabled: Boolean((basic.data as { charges_enabled?: boolean } | null)?.charges_enabled),
    onboardingComplete: true,
  };
}

/**
 * Can an academy collect an upfront ("pay directly") rebook payment? True when
 * Mollie is ready for online checkout OR the invoice business profile is complete
 * (the player gets an invoice with bank-transfer instructions). Used to gate the
 * "pay directly" option — and, via mollieReady, the STRICT pay-first checkbox — in
 * the rebook wizards.
 */
export async function getAcademyUpfrontEligibility(academyProfileId: string): Promise<UpfrontEligibility> {
  const [mollie, profileRes] = await Promise.all([
    fetchMollieReadiness(academyProfileId),
    supabase
      .from('academy_profiles')
      .select('business_name, business_address, kvk_number, iban')
      .eq('id', academyProfileId)
      .maybeSingle(),
  ]);

  const mollieReady = mollie.chargesEnabled && mollie.onboardingComplete;
  const invoiceReady = isInvoiceSettingsComplete(profileRes.data ?? null);
  return { canCharge: mollieReady || invoiceReady, mollieReady, invoiceReady };
}
