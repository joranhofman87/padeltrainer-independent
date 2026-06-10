/**
 * Shared invoice-ownership authorization.
 *
 * Several functions mutate an invoice (or its derived bookings/slots) and must
 * confirm the caller owns it: the invoice's trainer, a manager of the invoice's
 * academy, an admin, or a trusted service-role caller. Centralizing this avoids
 * each function re-implementing (and drifting on) the check.
 */

export type InvoiceOwnershipFlags = {
  isServiceRole: boolean;
  isAdmin: boolean;
  isOwningTrainer: boolean;
  isAcademyManager: boolean;
};

/** Pure decision: may this caller manage the invoice? */
export function isInvoiceManager(flags: InvoiceOwnershipFlags): boolean {
  return (
    flags.isServiceRole ||
    flags.isAdmin ||
    flags.isOwningTrainer ||
    flags.isAcademyManager
  );
}

type MinimalInvoice = {
  trainer_id?: string | null;
  academy_profile_id?: string | null;
};

type MinimalAuth = {
  isServiceRole: boolean;
  user: { id: string };
};

/**
 * Resolve whether `auth` may manage `invoice`, querying the DB for the trainer /
 * admin / academy-manager relationships. Service-role callers short-circuit true.
 */
export async function canManageInvoice(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  auth: MinimalAuth,
  invoice: MinimalInvoice,
): Promise<boolean> {
  if (auth.isServiceRole) return true;

  const userId = auth.user.id;
  const [{ data: trainerProfile }, { data: adminRow }] = await Promise.all([
    supabase.from("trainer_profiles").select("id").eq("user_id", userId).maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle(),
  ]);

  const isAdmin = !!adminRow;
  const isOwningTrainer = !!trainerProfile?.id && trainerProfile.id === invoice.trainer_id;

  let isAcademyManager = false;
  if (!isAdmin && !isOwningTrainer && invoice.academy_profile_id) {
    const { data: managed } = await supabase
      .from("academy_managers")
      .select("id")
      .eq("user_id", userId)
      .eq("academy_profile_id", invoice.academy_profile_id)
      .maybeSingle();
    isAcademyManager = !!managed;
  }

  return isInvoiceManager({
    isServiceRole: false,
    isAdmin,
    isOwningTrainer,
    isAcademyManager,
  });
}
