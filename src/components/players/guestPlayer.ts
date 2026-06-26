/**
 * Cross-role guest-player shape. Lives in the neutral players domain because it
 * is consumed by trainer, academy, and invoice surfaces alike — keeping it here
 * (rather than in a role folder) lets neutral/shared components reference it
 * without importing from components/trainer.
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
