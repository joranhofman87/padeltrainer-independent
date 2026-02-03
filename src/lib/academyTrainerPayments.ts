import { supabase } from "@/integrations/supabase/client";

export interface AcademyPaymentInfo {
  isAcademyTrainer: boolean;
  academyProfileId?: string;
  academyName?: string;
  academyMollieConnected: boolean;
  academyChargesEnabled: boolean;
}

/**
 * Check if a trainer is covered by academy payments.
 * An academy trainer doesn't need their own Mollie account if their academy has Mollie connected.
 */
export async function getAcademyPaymentInfo(trainerId: string): Promise<AcademyPaymentInfo> {
  // Check if trainer has an academy_trainer relationship
  const { data: academyTrainer, error: academyError } = await supabase
    .from('academy_trainers')
    .select(`
      academy_profile_id,
      status,
      academy:academy_profiles(id, name)
    `)
    .eq('trainer_profile_id', trainerId)
    .eq('status', 'active')
    .maybeSingle();

  if (academyError || !academyTrainer) {
    return {
      isAcademyTrainer: false,
      academyMollieConnected: false,
      academyChargesEnabled: false,
    };
  }

  const academyData = academyTrainer.academy as { id: string; name: string } | null;

  // Get academy's Mollie account status
  const { data: academyMollieAccount, error: mollieError } = await supabase
    .from('academy_mollie_accounts' as any)
    .select('mollie_organization_id, charges_enabled, onboarding_complete')
    .eq('academy_profile_id', academyTrainer.academy_profile_id)
    .maybeSingle();

  if (mollieError || !academyMollieAccount) {
    return {
      isAcademyTrainer: true,
      academyProfileId: academyTrainer.academy_profile_id,
      academyName: academyData?.name,
      academyMollieConnected: false,
      academyChargesEnabled: false,
    };
  }

  const typedAccount = academyMollieAccount as unknown as { mollie_organization_id: string; charges_enabled: boolean };

  return {
    isAcademyTrainer: true,
    academyProfileId: academyTrainer.academy_profile_id,
    academyName: academyData?.name,
    academyMollieConnected: !!typedAccount.mollie_organization_id,
    academyChargesEnabled: !!typedAccount.charges_enabled,
  };
}

/**
 * Check if a trainer has valid payment setup (either personal Mollie, manual invoicing, or academy coverage)
 */
export async function hasValidPaymentSetup(
  trainerId: string,
  trainerProfileId: string,
  useManualInvoicing?: boolean
): Promise<{
  valid: boolean;
  message?: string;
  isAcademyManaged?: boolean;
  academyName?: string;
}> {
  // If manual invoicing is enabled, payment setup is valid
  if (useManualInvoicing) {
    return { valid: true };
  }

  // Check if trainer is covered by academy payments
  const academyInfo = await getAcademyPaymentInfo(trainerProfileId);

  if (academyInfo.isAcademyTrainer) {
    if (academyInfo.academyChargesEnabled) {
      return {
        valid: true,
        isAcademyManaged: true,
        academyName: academyInfo.academyName,
      };
    } else {
      return {
        valid: false,
        isAcademyManaged: true,
        academyName: academyInfo.academyName,
        message: `Your academy (${academyInfo.academyName || 'Academy'}) needs to complete payment setup`,
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
