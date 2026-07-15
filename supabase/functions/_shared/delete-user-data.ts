import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  await Promise.all([
    supabaseAdmin.from("calendar_events").delete().eq("user_id", targetUserId),
    supabaseAdmin.from("user_calendar_connections").delete().eq("user_id", targetUserId),
  ]);

  // 2. Delete notification-related data
  await Promise.all([
    supabaseAdmin.from("notification_preferences").delete().eq("user_id", targetUserId),
    supabaseAdmin.from("notifications").delete().eq("user_id", targetUserId),
    supabaseAdmin.from("notification_queue").delete().eq("user_id", targetUserId),
  ]);

  // 3. Delete onboarding email data
  await Promise.all([
    supabaseAdmin.from("onboarding_email_queue").delete().eq("user_id", targetUserId),
    supabaseAdmin.from("onboarding_email_logs").delete().eq("user_id", targetUserId),
    supabaseAdmin.from("trainer_onboarding").delete().eq("user_id", targetUserId),
  ]);

  // 4. Delete user discounts and banner events
  await Promise.all([
    supabaseAdmin.from("user_discounts").delete().eq("user_id", targetUserId),
    supabaseAdmin.from("banner_events").delete().eq("user_id", targetUserId),
  ]);

  // 5. Handle club profiles created by this user
  const { data: userClubProfiles } = await supabaseAdmin
    .from("club_profiles")
    .select("id")
    .eq("created_by", targetUserId);

  if (userClubProfiles && userClubProfiles.length > 0) {
    const clubIds = userClubProfiles.map((c) => c.id);
    
    // Delete cycles owned by these clubs
    const { data: clubCycles } = await supabaseAdmin
      .from("cycles")
      .select("id")
      .eq("owner_type", "club")
      .in("owner_id", clubIds);

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
  await supabaseAdmin
    .from("club_profiles")
    .update({ created_by: null })
    .eq("created_by", targetUserId);

  // Remove user from club_managers
  await supabaseAdmin.from("club_managers").delete().eq("user_id", targetUserId);

  // 6. Handle academy profiles created by this user
  const { data: userAcademyProfiles } = await supabaseAdmin
    .from("academy_profiles")
    .select("id")
    .eq("created_by", targetUserId);

  if (userAcademyProfiles && userAcademyProfiles.length > 0) {
    const academyIds = userAcademyProfiles.map((c) => c.id);

    // Delete cycles owned by these academies
    const { data: academyCycles } = await supabaseAdmin
      .from("cycles")
      .select("id")
      .eq("owner_type", "academy")
      .in("owner_id", academyIds);

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
  await supabaseAdmin
    .from("academy_profiles")
    .update({ created_by: null })
    .eq("created_by", targetUserId);

  // Remove user from academy_managers
  await supabaseAdmin.from("academy_managers").delete().eq("user_id", targetUserId);

  // 7. Handle trainer profile if exists
  const { data: trainerProfile } = await supabaseAdmin
    .from("trainer_profiles")
    .select("id")
    .eq("user_id", targetUserId)
    .single();

  if (trainerProfile) {
    // Delete all trainer-related data in parallel where possible
    await Promise.all([
      supabaseAdmin.from("trainer_locations").delete().eq("trainer_id", trainerProfile.id),
      supabaseAdmin.from("trainer_followers").delete().eq("trainer_id", trainerProfile.id),
      supabaseAdmin.from("trainer_profile_views").delete().eq("trainer_id", trainerProfile.id),
      supabaseAdmin.from("trainer_working_hours").delete().eq("trainer_id", trainerProfile.id),
      supabaseAdmin.from("trainer_mollie_accounts").delete().eq("trainer_id", trainerProfile.id),
      supabaseAdmin.from("profile_videos").delete().eq("trainer_profile_id", trainerProfile.id),
      supabaseAdmin.from("proposed_assignments").delete().eq("trainer_id", trainerProfile.id),
    ]);

    // FK-ordered sequential deletes. guest_players is referenced by invoices
    // (NO ACTION) and intake_requests (NO ACTION), so BOTH must be removed
    // before guest_players or the guest_players delete is FK-rejected.
    // bookings.slot_id is ON DELETE CASCADE, so deleting the slots first
    // cascades away the bookings that reference these guests.
    await runDelete(
      supabaseAdmin.from("availability_slots").delete().eq("trainer_id", trainerProfile.id),
      "availability_slots"
    );

    // Delete cycles owned by this trainer (and their intake_requests, which
    // reference this trainer's guest_players via NO ACTION) BEFORE guest_players.
    const { data: trainerCycles } = await supabaseAdmin
      .from("cycles")
      .select("id")
      .eq("owner_type", "trainer")
      .eq("owner_id", trainerProfile.id);

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

    // invoices reference guest_players (NO ACTION) — must precede guest_players.
    await runDelete(
      supabaseAdmin.from("invoices").delete().eq("trainer_id", trainerProfile.id),
      "invoices"
    );

    // Now safe: all NO ACTION references to these guests are gone.
    await runDelete(
      supabaseAdmin.from("guest_players").delete().eq("trainer_id", trainerProfile.id),
      "guest_players"
    );

    // Remove trainer from academy associations and invitations
    await Promise.all([
      supabaseAdmin.from("academy_trainers").delete().eq("trainer_profile_id", trainerProfile.id),
      supabaseAdmin.from("academy_trainer_invitations").delete().eq("trainer_profile_id", trainerProfile.id),
      supabaseAdmin.from("club_trainer_invitations").delete().eq("trainer_profile_id", trainerProfile.id),
    ]);

    // Anonymize reviews of this trainer (keep for record-keeping)
    await supabaseAdmin
      .from("reviews")
      .update({ trainer_id: null })
      .eq("trainer_id", trainerProfile.id);

    // Delete trainer profile
    await supabaseAdmin.from("trainer_profiles").delete().eq("user_id", targetUserId);
  }

  // 8. Handle player profile if exists
  const { data: playerProfile } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("user_id", targetUserId)
    .single();

  if (playerProfile) {
    // Delete player-related data in parallel
    await Promise.all([
      supabaseAdmin.from("player_locations").delete().eq("profile_id", playerProfile.id),
      supabaseAdmin.from("player_rating_history").delete().eq("profile_id", playerProfile.id),
      supabaseAdmin.from("trainer_followers").delete().eq("player_id", playerProfile.id),
      supabaseAdmin.from("academy_followers").delete().eq("player_id", playerProfile.id),
      supabaseAdmin.from("club_followers").delete().eq("player_id", playerProfile.id),
      supabaseAdmin.from("waiting_list_entries").delete().eq("player_id", playerProfile.id),
      supabaseAdmin.from("subscription_payments").delete().eq("profile_id", playerProfile.id),
    ]);

    // Nullify linked_profile_id references (keep the roster entries)
    await Promise.all([
      supabaseAdmin.from("club_players").update({ linked_profile_id: null }).eq("linked_profile_id", playerProfile.id),
      supabaseAdmin.from("guest_players").update({ linked_profile_id: null }).eq("linked_profile_id", playerProfile.id),
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
    await supabaseAdmin
      .from("reviews")
      .update({ is_anonymous: true })
      .eq("player_id", playerProfile.id);

    // Anonymize invoices for this player
    await supabaseAdmin
      .from("invoices")
      .update({ player_id: null })
      .eq("player_id", playerProfile.id);

    // Anonymize intake requests by this player
    await supabaseAdmin
      .from("intake_requests")
      .update({ player_id: null })
      .eq("player_id", playerProfile.id);
  }

  // 9. Delete user roles
  await supabaseAdmin.from("user_roles").delete().eq("user_id", targetUserId);

  // 10. Delete profile
  await supabaseAdmin.from("profiles").delete().eq("user_id", targetUserId);

  // 11. Delete the auth user
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(targetUserId);

  if (deleteError) {
    console.error("Error deleting auth user:", deleteError);
    throw new Error("Failed to delete user from auth system");
  }
}
