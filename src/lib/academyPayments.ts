import { supabase } from "@/lib/supabaseClient";
import { logger } from '@/lib/logger';

export interface AcademyConnectStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  balance?: {
    available: Array<{ amount: number; currency: string }>;
    pending: Array<{ amount: number; currency: string }>;
  };
  mollieOrganizationId?: string;
}

export async function connectAcademyMollie(academyProfileId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('mollie-connect-academy', {
    body: { academyProfileId },
  });

  if (error) {
    throw new Error(error.message || 'Failed to connect payment account');
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data.url;
}

export async function checkAcademyConnectStatus(academyProfileId: string): Promise<AcademyConnectStatus> {
  const { data, error } = await supabase.functions.invoke('check-mollie-connect-status', {
    body: { entityType: 'academy', entityId: academyProfileId },
  });

  if (error) {
    throw new Error(error.message || 'Failed to check connect status');
  }

  if (data?.error) {
    throw new Error(data.error);
  }

  return data as AcademyConnectStatus;
}

export async function getAcademyMollieAccount(academyProfileId: string) {
  const { data, error } = await supabase
    .from('academy_mollie_accounts')
    .select('*')
    .eq('academy_profile_id', academyProfileId)
    .maybeSingle();

  if (error) {
    logger.error('Error fetching academy mollie account', error as Error, { component: 'academyPayments' });
    return null;
  }

  return data;
}

// Check if a trainer is part of an academy and get the academy's Mollie account
export async function getAcademyMollieAccountForTrainer(trainerId: string) {
  // Get trainer's active academy membership
  const { data: academyTrainer, error: trainerError } = await supabase
    .from('academy_trainers')
    .select(`
      academy_profile_id,
      status,
      academy:academy_profiles(id, name)
    `)
    .eq('trainer_profile_id', trainerId)
    .eq('status', 'active')
    .maybeSingle();

  if (trainerError || !academyTrainer) {
    return null; // Not part of an active academy
  }

  // Get the academy's Mollie account
  const { data: mollieAccount, error: mollieError } = await supabase
    .from('academy_mollie_accounts')
    .select('mollie_organization_id, charges_enabled')
    .eq('academy_profile_id', academyTrainer.academy_profile_id)
    .maybeSingle();

  if (mollieError || !mollieAccount) {
    return null;
  }

  return {
    academyProfileId: academyTrainer.academy_profile_id,
    mollieOrganizationId: mollieAccount.mollie_organization_id,
    chargesEnabled: mollieAccount.charges_enabled,
  };
}
