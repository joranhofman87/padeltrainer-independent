import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

/**
 * Await a Supabase delete/update builder, surface a real DB error instead of
 * swallowing it. Sequential FK-ordered deletes MUST go through this so an FK
 * rejection (e.g. a RESTRICT/NO ACTION reference blocking the delete) aborts
 * loudly rather than silently self-healing via an unrelated ON DELETE CASCADE.
 */
async function runDelete(
  op: PromiseLike<{ error: unknown }>,
  label: string
): Promise<void> {
  const { error } = await op;
  if (error) {
    console.error(`deleteUserData: failed to delete ${label}:`, error);
    const msg = (error as { message?: string } | null)?.message ?? String(error);
    throw new Error(`deleteUserData failed at ${label}: ${msg}`);
  }
}

/**
 * Await a GROUP of parallel delete/update builders and surface EVERY failure.
 *
 * `await Promise.all([builder, builder])` looks like error handling and is not: a Supabase
 * builder resolves to `{ data, error }` rather than rejecting, so a failed delete resolves
 * happily and the run continues to the next step — and, eventually, to deleting the auth user.
 * That turns an incomplete privacy operation into a silent one: the account is gone, the rows
 * are not, and nobody can revisit it because the identity that owned them no longer exists.
 *
 * So every group goes through here. It keeps the parallelism (these are independent tables) but
 * inspects each result, and throws naming the group and every table that failed. The caller's
 * failure is the point: `deleteUserData` must not reach the auth deletion after one.
 */
async function runAll(
  group: string,
  ops: Array<[string, PromiseLike<{ error: unknown }>]>,
): Promise<void> {
  const results = await Promise.all(
    ops.map(async ([label, op]) => {
      const { error } = await op;
      return { label, error };
    }),
  );
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    for (const f of failed) console.error(`deleteUserData: failed to delete ${f.label}:`, f.error);
    const detail = failed
      .map((f) => `${f.label}: ${(f.error as { message?: string } | null)?.message ?? String(f.error)}`)
      .join('; ');
    throw new Error(`deleteUserData failed at ${group} — ${detail}`);
  }
}

/**
 * A read whose RESULT DECIDES WHAT GETS DELETED must not fail silently.
 *
 * `{ data, error }` with the error dropped makes "this user owns no cycles" and "the query for
 * their cycles failed" the same value: an empty array. The first means there is nothing to
 * delete; the second means we do not know, and continuing to the auth deletion after it leaves
 * rows behind that nobody can reach again. PGRST116 is the exception — `.single()` reporting
 * "no rows" IS the answer, not a failure.
 */
function requireRead(error: unknown, label: string): void {
  if (!error) return;
  if ((error as { code?: string } | null)?.code === "PGRST116") return;   // .single() found nothing
  console.error(`deleteUserData: could not read ${label}:`, error);
  const msg = (error as { message?: string } | null)?.message ?? String(error);
  throw new Error(`deleteUserData failed reading ${label}: ${msg}`);
}

/**
 * Deletes all data associated with a user across all tables.
 * Used by both admin delete-user and self-service request-account-deletion.
 * 
 * @param supabaseAdmin - Service role Supabase client
 * @param targetUserId - The auth.users UUID of the user to delete
 * @param _preserveClubsAndAcademies - If true, nullifies created_by instead of deleting org profiles
 */
export async function deleteUserData(
  supabaseAdmin: SupabaseClient,
  targetUserId: string,
  _preserveClubsAndAcademies: boolean = true
) {
  // 1. Delete calendar events & calendar connections
  await runAll("calendar_events group", [
    ["calendar_events", supabaseAdmin.from("calendar_events").delete().eq("user_id", targetUserId)],
    ["user_calendar_connections", supabaseAdmin.from("user_calendar_connections").delete().eq("user_id", targetUserId)],
  ]);

  // 2. Delete notification-related data
  await runAll("notification_preferences group", [
    ["notification_preferences", supabaseAdmin.from("notification_preferences").delete().eq("user_id", targetUserId)],
    ["notifications", supabaseAdmin.from("notifications").delete().eq("user_id", targetUserId)],
    ["notification_queue", supabaseAdmin.from("notification_queue").delete().eq("user_id", targetUserId)],
  ]);

  // 3. Delete onboarding email data
  await runAll("onboarding_email_queue group", [
    ["onboarding_email_queue", supabaseAdmin.from("onboarding_email_queue").delete().eq("user_id", targetUserId)],
    ["onboarding_email_logs", supabaseAdmin.from("onboarding_email_logs").delete().eq("user_id", targetUserId)],
    ["trainer_onboarding", supabaseAdmin.from("trainer_onboarding").delete().eq("user_id", targetUserId)],
  ]);

  // 4. Delete user discounts and banner events
  await runAll("user_discounts group", [
    ["user_discounts", supabaseAdmin.from("user_discounts").delete().eq("user_id", targetUserId)],
    ["banner_events", supabaseAdmin.from("banner_events").delete().eq("user_id", targetUserId)],
  ]);

  // 5. Handle club profiles created by this user
  const { data: userClubProfiles, error: userClubProfilesErr } = await supabaseAdmin
    .from("club_profiles")
    .select("id")
    .eq("created_by", targetUserId);
  requireRead(userClubProfilesErr, "club profiles owned by the user");

  if (userClubProfiles && userClubProfiles.length > 0) {
    const clubIds = userClubProfiles.map((c) => c.id);
    
    // Delete cycles owned by these clubs
    const { data: clubCycles, error: clubCyclesErr } = await supabaseAdmin
      .from("cycles")
      .select("id")
      .eq("owner_type", "club")
      .in("owner_id", clubIds);
    requireRead(clubCyclesErr, "cycles of those clubs");

    if (clubCycles && clubCycles.length > 0) {
      const cycleIds = clubCycles.map((c) => c.id);
      // Delete the cycles' SLOTS first so their bookings + slot_priority_claims + session data
      // CASCADE (slot_id ON DELETE CASCADE). Deleting only the cycle SET-NULLs each slot's cyclus_id
      // (that FK is ON DELETE SET NULL), leaving ORPHANED slots with dangling bookings/claims — the
      // departed user's session data persists (privacy). runDelete surfaces FK errors loudly instead
      // of the previous bare await, which swallowed them into a silent partial delete.
      await runDelete(
        supabaseAdmin.from("availability_slots").delete().in("cyclus_id", cycleIds),
        "availability_slots (club cycles)",
      );
      await runDelete(
        supabaseAdmin.from("intake_requests").delete().in("cycle_id", cycleIds),
        "intake_requests (club cycles)",
      );
      await runDelete(
        supabaseAdmin.from("cycles").delete().in("id", cycleIds),
        "cycles (club)",
      );
    }
  }

  // Nullify created_by on club profiles (preserve the club itself)
  await runDelete(
    supabaseAdmin
    .from("club_profiles")
    .update({ created_by: null })
    .eq("created_by", targetUserId),
    "club_profiles (anonymize)");

  // Remove user from club_managers
  await runDelete(supabaseAdmin.from("club_managers").delete().eq("user_id", targetUserId), "club_managers");

  // 6. Handle academy profiles created by this user
  const { data: userAcademyProfiles, error: userAcademyProfilesErr } = await supabaseAdmin
    .from("academy_profiles")
    .select("id")
    .eq("created_by", targetUserId);
  requireRead(userAcademyProfilesErr, "academy profiles owned by the user");

  if (userAcademyProfiles && userAcademyProfiles.length > 0) {
    const academyIds = userAcademyProfiles.map((c) => c.id);

    // Delete cycles owned by these academies
    const { data: academyCycles, error: academyCyclesErr } = await supabaseAdmin
      .from("cycles")
      .select("id")
      .eq("owner_type", "academy")
      .in("owner_id", academyIds);
    requireRead(academyCyclesErr, "cycles of those academies");

    if (academyCycles && academyCycles.length > 0) {
      const cycleIds = academyCycles.map((c) => c.id);
      // Same as the club branch: delete the cycles' SLOTS first so bookings + priority claims +
      // session data cascade, instead of orphaning them via the cyclus_id SET NULL; surface errors.
      await runDelete(
        supabaseAdmin.from("availability_slots").delete().in("cyclus_id", cycleIds),
        "availability_slots (academy cycles)",
      );
      await runDelete(
        supabaseAdmin.from("intake_requests").delete().in("cycle_id", cycleIds),
        "intake_requests (academy cycles)",
      );
      await runDelete(
        supabaseAdmin.from("cycles").delete().in("id", cycleIds),
        "cycles (academy)",
      );
    }
  }

  // Nullify created_by on academy profiles (preserve the academy itself)
  await runDelete(
    supabaseAdmin
    .from("academy_profiles")
    .update({ created_by: null })
    .eq("created_by", targetUserId),
    "academy_profiles (anonymize)");

  // Remove user from academy_managers
  await runDelete(supabaseAdmin.from("academy_managers").delete().eq("user_id", targetUserId), "academy_managers");

  // 7. Handle trainer profile if exists
  const { data: trainerProfile, error: trainerProfileErr } = await supabaseAdmin
    .from("trainer_profiles")
    .select("id")
    .eq("user_id", targetUserId)
    .single();
  requireRead(trainerProfileErr, "the trainer profile");

  if (trainerProfile) {
    // Delete all trainer-related data in parallel where possible
    await runAll("trainer_locations group", [
      ["trainer_locations", supabaseAdmin.from("trainer_locations").delete().eq("trainer_id", trainerProfile.id)],
      ["trainer_followers", supabaseAdmin.from("trainer_followers").delete().eq("trainer_id", trainerProfile.id)],
      ["trainer_profile_views", supabaseAdmin.from("trainer_profile_views").delete().eq("trainer_id", trainerProfile.id)],
      ["trainer_working_hours", supabaseAdmin.from("trainer_working_hours").delete().eq("trainer_id", trainerProfile.id)],
      ["trainer_mollie_accounts", supabaseAdmin.from("trainer_mollie_accounts").delete().eq("trainer_id", trainerProfile.id)],
      ["profile_videos", supabaseAdmin.from("profile_videos").delete().eq("trainer_profile_id", trainerProfile.id)],
      ["proposed_assignments", supabaseAdmin.from("proposed_assignments").delete().eq("trainer_id", trainerProfile.id)],
    ]);

    // RETAIN financial records (R03). Previously this branch hard-deleted the trainer's
    // availability_slots (cascading away every booking on them, paid included) and invoices —
    // erasing legally-required financial history. Now the slots + their bookings + the invoices are
    // KEPT; the trainer_profiles row is anonymized into a shell (below) so those FKs stay valid.

    // Delete cycles owned by this trainer + their intake_requests. Cycles are programs, not
    // financial records: availability_slots.cyclus_id and invoices.cycle_id are ON DELETE SET NULL,
    // so removing the cycle detaches the retained slots/invoices from it rather than erasing them.
    const { data: trainerCycles, error: trainerCyclesErr } = await supabaseAdmin
      .from("cycles")
      .select("id")
      .eq("owner_type", "trainer")
      .eq("owner_id", trainerProfile.id);
    requireRead(trainerCyclesErr, "cycles owned by the trainer");

    if (trainerCycles && trainerCycles.length > 0) {
      const cycleIds = trainerCycles.map((c) => c.id);
      await runDelete(
        supabaseAdmin.from("intake_requests").delete().in("cycle_id", cycleIds),
        "intake_requests (trainer cycles)"
      );
      await runDelete(
        supabaseAdmin.from("cycles").delete().in("id", cycleIds),
        "cycles (trainer)"
      );
    }

    // Erase the trainer's guest players (students). The RETAINED invoices reference them via
    // invoices.guest_player_id, now ON DELETE SET NULL (was NO ACTION) — so this delete succeeds and
    // the invoice keeps the customer name/address it denormalized at issue time (a legal record).
    // bookings.guest_player_id is already SET NULL, so the retained bookings survive too.
    await runDelete(
      supabaseAdmin.from("guest_players").delete().eq("trainer_id", trainerProfile.id),
      "guest_players"
    );

    // Remove trainer from academy associations and invitations
    await runAll("academy_trainers group", [
      ["academy_trainers", supabaseAdmin.from("academy_trainers").delete().eq("trainer_profile_id", trainerProfile.id)],
      ["academy_trainer_invitations", supabaseAdmin.from("academy_trainer_invitations").delete().eq("trainer_profile_id", trainerProfile.id)],
      ["club_trainer_invitations", supabaseAdmin.from("club_trainer_invitations").delete().eq("trainer_profile_id", trainerProfile.id)],
    ]);

    // Anonymize reviews of this trainer (keep for record-keeping)
    await runDelete(
      supabaseAdmin
      .from("reviews")
      .update({ trainer_id: null })
      .eq("trainer_id", trainerProfile.id),
      "reviews (anonymize)");

    // Anonymize the trainer_profiles row into a retained SHELL instead of deleting it (R03): null the
    // business/identity PII, hide it, detach it from the (about-to-be-deleted) auth user, and stamp
    // anonymized_at. Keeping the row keeps invoices.trainer_id + availability_slots.trainer_id valid,
    // so the retained invoices/slots/bookings are never cascade-erased — including by the final
    // auth.deleteUser() (user_id is nulled here, and its FK is now ON DELETE SET NULL as a backstop).
    // The trainer's name/email live on the profiles row, erased separately below.
    await runDelete(
      supabaseAdmin
        .from("trainer_profiles")
        .update({
          user_id: null,
          anonymized_at: new Date().toISOString(),
          is_public: false,
          is_verified: false,
          business_name: null,
          business_address: null,
          kvk_number: null,
          btw_number: null,
          iban: null,
          bic: null,
          stripe_account_id: null,
          hourly_rate: null,
          certifications: null,
          specializations: null,
          experience_years: null,
          knltb_rating: null,
          favourite_quote: null,
          coaching_method: null,
          video_url: null,
          website_url: null,
          slug: null,
          social_instagram: null,
          social_tiktok: null,
          social_youtube: null,
          social_linkedin: null,
        })
        .eq("id", trainerProfile.id),
      "trainer_profiles (anonymize shell)",
    );
  }

  // 8. Handle player profile if exists
  const { data: playerProfile, error: playerProfileErr } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("user_id", targetUserId)
    .single();
  requireRead(playerProfileErr, "the player profile");

  if (playerProfile) {
    // Delete player-related data in parallel
    await runAll("player_locations group", [
      ["player_locations", supabaseAdmin.from("player_locations").delete().eq("profile_id", playerProfile.id)],
      ["player_rating_history", supabaseAdmin.from("player_rating_history").delete().eq("profile_id", playerProfile.id)],
      ["trainer_followers", supabaseAdmin.from("trainer_followers").delete().eq("player_id", playerProfile.id)],
      ["academy_followers", supabaseAdmin.from("academy_followers").delete().eq("player_id", playerProfile.id)],
      ["club_followers", supabaseAdmin.from("club_followers").delete().eq("player_id", playerProfile.id)],
      ["waiting_list_entries", supabaseAdmin.from("waiting_list_entries").delete().eq("player_id", playerProfile.id)],
      ["subscription_payments", supabaseAdmin.from("subscription_payments").delete().eq("profile_id", playerProfile.id)],
    ]);

    // Nullify linked_profile_id references (keep the roster entries)
    await runAll("club_players group", [
      ["club_players", supabaseAdmin.from("club_players").update({ linked_profile_id: null }).eq("linked_profile_id", playerProfile.id)],
      ["guest_players", supabaseAdmin.from("guest_players").update({ linked_profile_id: null }).eq("linked_profile_id", playerProfile.id)],
    ]);

    // Anonymize bookings (keep for record-keeping): detach the player and stamp anonymized_at so
    // booking_has_player permits the now owner-less row (R02). MUST go through runDelete — a bare
    // await previously swallowed the 23514 the old CHECK raised, so 0 rows were anonymized and the
    // profiles.delete() below then cascaded these paid/completed bookings away. player_id's FK is
    // now ON DELETE SET NULL, so this also degrades safely if the stamp write ever regressed.
    await runDelete(
      supabaseAdmin
        .from("bookings")
        .update({ player_id: null, anonymized_at: new Date().toISOString() })
        .eq("player_id", playerProfile.id),
      "bookings (anonymize)",
    );

    // Anonymize reviews by this player
    await runDelete(
      supabaseAdmin
      .from("reviews")
      .update({ is_anonymous: true })
      .eq("player_id", playerProfile.id),
      "reviews (anonymize)");

    // Anonymize invoices for this player
    await runDelete(
      supabaseAdmin
      .from("invoices")
      .update({ player_id: null })
      .eq("player_id", playerProfile.id),
      "invoices (anonymize)");

    // Anonymize intake requests by this player
    await runDelete(
      supabaseAdmin
      .from("intake_requests")
      .update({ player_id: null })
      .eq("player_id", playerProfile.id),
      "intake_requests (anonymize)");
  }

  // 9. Delete user roles
  await runDelete(supabaseAdmin.from("user_roles").delete().eq("user_id", targetUserId), "user_roles");

  // 10. Delete profile
  await runDelete(supabaseAdmin.from("profiles").delete().eq("user_id", targetUserId), "profiles");

  // 10b. Remove the user's avatar/banner objects (R06): the 'avatars' bucket is PUBLIC and these
  // live under the user's own folder (`<user_id>/avatar.*`, `<user_id>/banner.*`) — leaving them
  // would keep the deleted user's face publicly reachable forever. Best-effort: a storage hiccup
  // must never block the account deletion (the objects are only reachable via the now-deleted
  // profile's URL anyway). Org logos under 'clubs/…' etc. are untouched — not user PII.
  try {
    const { data: avatarObjects } = await supabaseAdmin.storage.from("avatars").list(targetUserId);
    const avatarPaths = (avatarObjects ?? []).map((o: { name: string }) => `${targetUserId}/${o.name}`);
    if (avatarPaths.length > 0) {
      await supabaseAdmin.storage.from("avatars").remove(avatarPaths);
    }
  } catch (avatarErr) {
    console.error("deleteUserData: avatar cleanup failed (non-blocking):", avatarErr);
  }

  // 11. Delete the auth user — LAST, and reachable only because nothing above threw.
  //
  // That ordering is the whole safety property. Every step from here backwards fails loudly, so
  // this line is unreachable after an unacknowledged cleanup failure: the account survives, the
  // caller gets an error, and the operation can be retried against an identity that still exists.
  // The previous version awaited its deletes without inspecting them, which meant this ran no
  // matter what — deleting the only key to the rows it had failed to remove.
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(targetUserId);

  if (deleteError) {
    console.error("Error deleting auth user:", deleteError);
    throw new Error("Failed to delete user from auth system");
  }
}
