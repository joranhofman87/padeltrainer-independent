/**
 * Cross-role guest-player shape. Lives in the neutral players domain because it
 * is consumed by trainer, academy, and invoice surfaces alike — keeping it here
 * (rather than in a role folder) lets neutral/shared components reference it
 * without importing from components/trainer.
 *
 * This is the shape of the LEGACY LIST surfaces (rows read from `guest_players`
 * until the person-unification contraction retires them). The CREATE flows no
 * longer produce it — they answer with {@link CreatedPlayer}, which is keyed on
 * the canonical person and carries no legacy id at all.
 */
export interface GuestPlayer {
  id: string;
  trainer_id: string | null;
  academy_profile_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  linked_profile_id: string | null;
}

/**
 * What the add/import flows hand their callers after a create: the person-keyed
 * display projection (`person_display_for_owner`), showing the STORED truth —
 * a replayed create answers with the Player that already existed, whose
 * attributes may differ from what was just typed.
 *
 * Deliberately NO `guest_player_id` and no other legacy id (U2, owner
 * correction 2026-08-09): a consumer that needs to locate this Player in a
 * still-legacy list matches that list's own rows on `personId`.
 */
export interface CreatedPlayer {
  personId: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  created_at: string;
}
