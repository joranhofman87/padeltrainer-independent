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
  payouts_enabled?: boolean;
  onboarding_complete: boolean;
  mollie_organization_id?: string | null;
};

export type TrainerMollieAccountRow = {
  access_token: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
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

export function isMollieOrganizationConnected(
  mollieOrganizationId: string | null | undefined,
): boolean {
  return !!mollieOrganizationId && !mollieOrganizationId.startsWith("pending_");
}

/** Status fields returned by check-mollie-connect-status (no raw tokens). */
export function buildAcademyMollieConnectStatus(
  account: AcademyMollieAccountRow | null | undefined,
) {
  const connected = isMollieOrganizationConnected(account?.mollie_organization_id);
  const readiness = evaluateAcademyMollieReadiness(account);
  return {
    connected,
    paymentReady: connected && readiness.ready,
    paymentUnavailableReason: connected && !readiness.ready ? (readiness.reason ?? null) : null,
    hasAccessToken: !!account?.access_token,
    hasRefreshToken: !!account?.refresh_token,
    chargesEnabled: account?.charges_enabled ?? false,
    payoutsEnabled: account?.payouts_enabled ?? false,
    onboardingComplete: account?.onboarding_complete ?? false,
    mollieOrganizationId: account?.mollie_organization_id ?? undefined,
  };
}

export function buildTrainerMollieConnectStatus(
  account: TrainerMollieAccountRow | null | undefined,
) {
  const connected = isMollieOrganizationConnected(account?.mollie_organization_id);
  const readiness = evaluateTrainerMollieReadiness(account);
  return {
    connected,
    paymentReady: connected && readiness.ready,
    paymentUnavailableReason: connected && !readiness.ready ? (readiness.reason ?? null) : null,
    hasAccessToken: !!account?.access_token,
    hasRefreshToken: !!account?.refresh_token,
    chargesEnabled: account?.charges_enabled ?? false,
    payoutsEnabled: account?.payouts_enabled ?? false,
    onboardingComplete: account?.onboarding_complete ?? false,
    mollieOrganizationId: account?.mollie_organization_id ?? undefined,
  };
}

export const MOLLIE_CONNECT_STATUS_DISCONNECTED = {
  connected: false,
  paymentReady: false,
  paymentUnavailableReason: null as MolliePaymentUnavailableReason | null,
  hasAccessToken: false,
  hasRefreshToken: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  onboardingComplete: false,
};

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
