import { supabase } from "@/integrations/supabase/client";

export interface ClubConnectStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  balance?: {
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  };
  stripeAccountId?: string;
}

export async function connectClubStripe(clubProfileId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('connect-club', {
    body: { clubProfileId },
  });

  if (error) {
    throw new Error(error.message || 'Failed to connect Stripe');
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data.url;
}

export async function checkClubConnectStatus(clubProfileId: string): Promise<ClubConnectStatus> {
  const { data, error } = await supabase.functions.invoke('check-club-connect-status', {
    body: { clubProfileId },
  });

  if (error) {
    throw new Error(error.message || 'Failed to check connect status');
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data as ClubConnectStatus;
}

export async function getClubStripeAccount(clubProfileId: string) {
  const { data, error } = await supabase
    .from('club_stripe_accounts')
    .select('*')
    .eq('club_profile_id', clubProfileId)
    .maybeSingle();

  if (error) {
    console.error('Error fetching club stripe account:', error);
    return null;
  }

  return data;
}

// Check if a trainer is a club trainer and get the club's Stripe account
export async function getClubStripeAccountForTrainer(trainerId: string, locationId?: string) {
  // Get trainer's club location
  let query = supabase
    .from('trainer_locations')
    .select(`
      location_id,
      relationship_type,
      location:locations(id, name)
    `)
    .eq('trainer_id', trainerId)
    .eq('relationship_type', 'club_trainer');

  if (locationId) {
    query = query.eq('location_id', locationId);
  }

  const { data: trainerLocation, error: locationError } = await query.maybeSingle();

  if (locationError || !trainerLocation) {
    return null; // Not a club trainer or no matching location
  }

  // Get the club profile for this location
  const { data: clubProfile, error: clubError } = await supabase
    .from('club_profiles')
    .select('id')
    .eq('location_id', trainerLocation.location_id)
    .maybeSingle();

  if (clubError || !clubProfile) {
    return null; // No club profile for this location
  }

  // Get the club's Stripe account
  const { data: stripeAccount, error: stripeError } = await supabase
    .from('club_stripe_accounts')
    .select('stripe_account_id, charges_enabled')
    .eq('club_profile_id', clubProfile.id)
    .maybeSingle();

  if (stripeError || !stripeAccount) {
    return null;
  }

  return {
    clubProfileId: clubProfile.id,
    stripeAccountId: stripeAccount.stripe_account_id,
    chargesEnabled: stripeAccount.charges_enabled,
  };
}
