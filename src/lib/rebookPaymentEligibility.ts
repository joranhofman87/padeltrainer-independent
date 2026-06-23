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
 * Can an academy collect an upfront ("pay directly") rebook payment? True when
 * Mollie is connected (online checkout) OR the invoice business profile is complete
 * (the player gets an invoice with bank-transfer instructions). Used to gate the
 * "pay directly" option in the rebook wizards.
 */
export async function getAcademyUpfrontEligibility(academyProfileId: string): Promise<UpfrontEligibility> {
  const [mollieRes, profileRes] = await Promise.all([
    supabase
      .from('academy_mollie_status' as never)
      .select('charges_enabled')
      .eq('academy_profile_id', academyProfileId)
      .maybeSingle(),
    supabase
      .from('academy_profiles')
      .select('business_name, business_address, kvk_number, iban')
      .eq('id', academyProfileId)
      .maybeSingle(),
  ]);

  const mollieReady = Boolean((mollieRes.data as { charges_enabled?: boolean } | null)?.charges_enabled);
  const invoiceReady = isInvoiceSettingsComplete(profileRes.data ?? null);
  return { canCharge: mollieReady || invoiceReady, mollieReady, invoiceReady };
}
