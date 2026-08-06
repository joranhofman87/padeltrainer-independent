/**
 * WHO MAY CHANGE WHAT ON A TRAINER'S ACCOUNT.
 *
 * A trainer has ONE login and ONE `profiles` row, and can work for several academies and clubs at
 * the same time. Those two facts together are the whole problem: authority to manage a trainer
 * *within your academy* is not authority over the identity they use everywhere else.
 *
 * The capability being preserved is real — an academy that created a trainer's account, and is the
 * only tenant they work for, manages it end to end, including rotating the login. That is
 * deliberate and it stays. What A1-A7 F3 found is that the same code path let a manager of academy
 * A change the global email and shared profile of a trainer who ALSO works for academy B: it
 * rotates a login A does not own, and rewrites the name and photo B sees, with no B-side consent
 * or even notice.
 *
 * So the rule is exclusivity, checked server-side against every ACTIVE relationship:
 *
 *   * the caller manages every tenant the trainer is active in  → global identity is theirs to
 *     change (audited, and the old address is notified, as before);
 *   * the trainer is active anywhere the caller does not manage → the caller may not touch the
 *     global identity at all. Tenant-scoped overlays are unaffected; this module says nothing
 *     about them.
 *
 * Platform admins and the trainer themselves are outside this: they are handled by their own
 * branches and never reach here.
 */

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface TrainerTenancy {
  /** every ACTIVE academy + club the trainer works for, as `academy:<id>` / `club:<id>`. */
  activeTenants: string[];
  /** the subset of those the caller manages. */
  managedTenants: string[];
  /**
   * true when the caller manages EVERY tenant the trainer is active in (and there is at least
   * one). Only then is the trainer's global identity the caller's to change.
   */
  isExclusiveToCaller: boolean;
  /** tenants the trainer works for that the caller does NOT manage — the reason for a refusal. */
  foreignTenants: string[];
}

/**
 * Fails CLOSED: any read error is reported as `null`, and the caller must treat that as "no
 * exclusivity established" rather than assuming it. An unreadable relationship table must never
 * widen someone's authority.
 */
export async function assessTrainerTenancy(
  supabaseAdmin: Db,
  callerUserId: string,
  trainerProfileId: string,
): Promise<TrainerTenancy | null> {
  if (!callerUserId || !trainerProfileId) return null;

  const [academies, clubs, managedAcademies, managedClubs] = await Promise.all([
    supabaseAdmin.from("academy_trainers").select("academy_profile_id")
      .eq("trainer_profile_id", trainerProfileId).eq("status", "active"),
    supabaseAdmin.from("club_trainers").select("club_profile_id")
      .eq("trainer_profile_id", trainerProfileId).eq("status", "active"),
    supabaseAdmin.from("academy_managers").select("academy_profile_id").eq("user_id", callerUserId),
    supabaseAdmin.from("club_managers").select("club_profile_id").eq("user_id", callerUserId),
  ]);
  if (academies.error || clubs.error || managedAcademies.error || managedClubs.error) return null;

  const activeTenants = [
    ...(academies.data ?? []).map((r: { academy_profile_id: string }) => `academy:${r.academy_profile_id}`),
    ...(clubs.data ?? []).map((r: { club_profile_id: string }) => `club:${r.club_profile_id}`),
  ];
  const managed = new Set([
    ...(managedAcademies.data ?? []).map((r: { academy_profile_id: string }) => `academy:${r.academy_profile_id}`),
    ...(managedClubs.data ?? []).map((r: { club_profile_id: string }) => `club:${r.club_profile_id}`),
  ]);

  const managedTenants = activeTenants.filter((t) => managed.has(t));
  const foreignTenants = activeTenants.filter((t) => !managed.has(t));
  return {
    activeTenants,
    managedTenants,
    foreignTenants,
    isExclusiveToCaller: activeTenants.length > 0 && foreignTenants.length === 0,
  };
}

/**
 * The fields that live on the ONE shared identity — the login and the `profiles` row every tenant
 * reads. Listed explicitly rather than derived, so adding a profile column is a decision about
 * whose it is rather than an accident.
 */
export const GLOBAL_IDENTITY_FIELDS = [
  "email", "full_name", "phone", "bio", "avatar_url",
  "skill_rating", "rating_system", "rating_member_id",
] as const;
