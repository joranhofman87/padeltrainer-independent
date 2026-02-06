import { supabase } from "@/lib/supabaseClient";

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

  // Get academy's Mollie account status via secure view
  const { data: academyMollieStatus, error: mollieError } = await supabase
    .from('academy_mollie_status' as any)
    .select('is_connected, charges_enabled')
    .eq('academy_profile_id', academyTrainer.academy_profile_id)
    .maybeSingle();

  if (mollieError || !academyMollieStatus) {
    return {
      isAcademyTrainer: true,
      academyProfileId: academyTrainer.academy_profile_id,
      academyName: academyData?.name,
      academyMollieConnected: false,
      academyChargesEnabled: false,
    };
  }

  const typedStatus = academyMollieStatus as unknown as { is_connected: boolean; charges_enabled: boolean };

  return {
    isAcademyTrainer: true,
    academyProfileId: academyTrainer.academy_profile_id,
    academyName: academyData?.name,
    academyMollieConnected: typedStatus.is_connected,
    academyChargesEnabled: typedStatus.charges_enabled,
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

  // Check trainer's personal Mollie account via secure view
  const { data: mollieStatus } = await supabase
    .from('trainer_mollie_status' as any)
    .select('is_connected, charges_enabled')
    .eq('trainer_id', trainerProfileId)
    .maybeSingle();

  const typedStatus = mollieStatus as unknown as { is_connected: boolean; charges_enabled: boolean } | null;

  if (typedStatus?.charges_enabled) {
    return { valid: true };
  }

  return {
    valid: false,
    message: 'Please connect your payment account or enable manual invoicing',
  };
}
