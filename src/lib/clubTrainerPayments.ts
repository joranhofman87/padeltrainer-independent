import { supabase } from "@/integrations/supabase/client";

export interface ClubPaymentInfo {
  isClubTrainer: boolean;
  clubProfileId?: string;
  clubName?: string;
  clubMollieConnected: boolean;
  clubChargesEnabled: boolean;
}

/**
 * Check if a trainer is covered by club payments.
 * A club trainer doesn't need their own Mollie account if their club has Mollie connected.
 */
export async function getClubPaymentInfo(trainerId: string): Promise<ClubPaymentInfo> {
  // Check if trainer has a club_trainer relationship
  const { data: trainerLocations, error: locationError } = await supabase
    .from('trainer_locations')
    .select(`
      location_id,
      relationship_type,
      location:locations(id, name)
    `)
    .eq('trainer_id', trainerId)
    .eq('relationship_type', 'club_trainer');

  if (locationError || !trainerLocations || trainerLocations.length === 0) {
    return {
      isClubTrainer: false,
      clubMollieConnected: false,
      clubChargesEnabled: false,
    };
  }

  // Get the first club location
  const clubLocation = trainerLocations[0];
  const locationData = clubLocation.location as { id: string; name: string } | null;

  // Get club profile for this location
  const { data: clubProfile, error: clubError } = await supabase
    .from('club_profiles')
    .select('id')
    .eq('location_id', clubLocation.location_id)
    .maybeSingle();

  if (clubError || !clubProfile) {
    return {
      isClubTrainer: true,
      clubName: locationData?.name,
      clubMollieConnected: false,
      clubChargesEnabled: false,
    };
  }

  // Get club's Mollie account status
  const { data: clubMollieAccount, error: mollieError } = await supabase
    .from('club_mollie_accounts' as any)
    .select('mollie_organization_id, charges_enabled, onboarding_complete')
    .eq('club_profile_id', clubProfile.id)
    .maybeSingle();

  if (mollieError || !clubMollieAccount) {
    return {
      isClubTrainer: true,
      clubProfileId: clubProfile.id,
      clubName: locationData?.name,
      clubMollieConnected: false,
      clubChargesEnabled: false,
    };
  }

  const typedAccount = clubMollieAccount as unknown as { mollie_organization_id: string; charges_enabled: boolean };

  return {
    isClubTrainer: true,
    clubProfileId: clubProfile.id,
    clubName: locationData?.name,
    clubMollieConnected: !!typedAccount.mollie_organization_id,
    clubChargesEnabled: !!typedAccount.charges_enabled,
  };
}

/**
 * Check if a trainer has valid payment setup (either personal Mollie, manual invoicing, or club coverage)
 */
export async function hasValidPaymentSetup(
  trainerId: string,
  trainerProfileId: string,
  useManualInvoicing?: boolean
): Promise<{
  valid: boolean;
  message?: string;
  isClubManaged?: boolean;
  clubName?: string;
}> {
  // If manual invoicing is enabled, payment setup is valid
  if (useManualInvoicing) {
    return { valid: true };
  }

  // Check if trainer is covered by club payments
  const clubInfo = await getClubPaymentInfo(trainerProfileId);

  if (clubInfo.isClubTrainer) {
    if (clubInfo.clubChargesEnabled) {
      return {
        valid: true,
        isClubManaged: true,
        clubName: clubInfo.clubName,
      };
    } else {
      return {
        valid: false,
        isClubManaged: true,
        clubName: clubInfo.clubName,
        message: `Your club (${clubInfo.clubName || 'Club'}) needs to complete payment setup`,
      };
    }
  }

  // Check trainer's personal Mollie account
  const { data: mollieAccount } = await supabase
    .from('trainer_mollie_accounts' as any)
    .select('mollie_organization_id, charges_enabled, onboarding_complete')
    .eq('trainer_id', trainerProfileId)
    .maybeSingle();

  const typedAccount = mollieAccount as unknown as { charges_enabled: boolean } | null;

  if (typedAccount?.charges_enabled) {
    return { valid: true };
  }

  return {
    valid: false,
    message: 'Please connect your payment account or enable manual invoicing',
  };
}
