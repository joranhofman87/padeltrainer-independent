/** Shared criteria for public invoice Pay button and create-invoice-payment. */

export type MolliePaymentUnavailableReason =
  | "no_row"
  | "onboarding_incomplete"
  | "charges_disabled"
  | "missing_access_token";

export type AcademyMollieAccountRow = {
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  charges_enabled: boolean;
  onboarding_complete: boolean;
  mollie_organization_id?: string | null;
};

export type TrainerMollieAccountRow = {
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  onboarding_complete: boolean;
  mollie_organization_id?: string | null;
};

export type MolliePaymentReadiness<TAccount> = {
  ready: boolean;
  reason?: MolliePaymentUnavailableReason;
  account?: TAccount;
};

export function evaluateAcademyMollieReadiness(
  account: AcademyMollieAccountRow | null | undefined,
): MolliePaymentReadiness<AcademyMollieAccountRow> {
  if (!account) {
    return { ready: false, reason: "no_row" };
  }
  if (!account.onboarding_complete) {
    return { ready: false, reason: "onboarding_incomplete", account };
  }
  if (!account.charges_enabled) {
    return { ready: false, reason: "charges_disabled", account };
  }
  if (!account.access_token) {
    return { ready: false, reason: "missing_access_token", account };
  }
  return { ready: true, account };
}

export function evaluateTrainerMollieReadiness(
  account: TrainerMollieAccountRow | null | undefined,
): MolliePaymentReadiness<TrainerMollieAccountRow> {
  if (!account) {
    return { ready: false, reason: "no_row" };
  }
  if (!account.onboarding_complete) {
    return { ready: false, reason: "onboarding_incomplete", account };
  }
  if (!account.access_token) {
    return { ready: false, reason: "missing_access_token", account };
  }
  return { ready: true, account };
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = { from: (table: string) => any };

export async function getAcademyMolliePaymentReadiness(
  supabase: SupabaseClient,
  academyProfileId: string,
): Promise<MolliePaymentReadiness<AcademyMollieAccountRow>> {
  const { data } = await supabase
    .from("academy_mollie_accounts")
    .select(
      "access_token, refresh_token, token_expires_at, charges_enabled, onboarding_complete, mollie_organization_id",
    )
    .eq("academy_profile_id", academyProfileId)
    .maybeSingle();

  return evaluateAcademyMollieReadiness(data);
}

export async function getTrainerMolliePaymentReadiness(
  supabase: SupabaseClient,
  trainerId: string,
): Promise<MolliePaymentReadiness<TrainerMollieAccountRow>> {
  const { data } = await supabase
    .from("trainer_mollie_accounts")
    .select(
      "access_token, refresh_token, token_expires_at, onboarding_complete, mollie_organization_id",
    )
    .eq("trainer_id", trainerId)
    .maybeSingle();

  return evaluateTrainerMollieReadiness(data);
}

export async function getPublicInvoiceMollieReadiness(
  supabase: SupabaseClient,
  invoice: { academy_profile_id: string | null; trainer_id: string | null },
): Promise<{
  hasMollieAccount: boolean;
  paymentUnavailableReason?: MolliePaymentUnavailableReason;
  paymentRecipient: "academy" | "trainer" | null;
  academyReadiness?: MolliePaymentReadiness<AcademyMollieAccountRow>;
  trainerReadiness?: MolliePaymentReadiness<TrainerMollieAccountRow>;
}> {
  if (invoice.academy_profile_id) {
    const academyReadiness = await getAcademyMolliePaymentReadiness(
      supabase,
      invoice.academy_profile_id,
    );
    return {
      hasMollieAccount: academyReadiness.ready,
      paymentUnavailableReason: academyReadiness.ready ? undefined : academyReadiness.reason,
      paymentRecipient: "academy",
      academyReadiness,
    };
  }

  if (invoice.trainer_id) {
    const trainerReadiness = await getTrainerMolliePaymentReadiness(supabase, invoice.trainer_id);
    return {
      hasMollieAccount: trainerReadiness.ready,
      paymentUnavailableReason: trainerReadiness.ready ? undefined : trainerReadiness.reason,
      paymentRecipient: "trainer",
      trainerReadiness,
    };
  }

  return {
    hasMollieAccount: false,
    paymentUnavailableReason: "no_row",
    paymentRecipient: null,
  };
}
