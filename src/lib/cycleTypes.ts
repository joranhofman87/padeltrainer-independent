// Core cycle/intake/proposal domain types — extracted from lib/cycles.ts (god-file split).
// Pure type declarations (zero runtime); cycles.ts re-exports them so importers are unchanged.

export interface PriceTableRow {
  label: string;
  price: number;
  extra_prices?: { column_name: string; price: number }[];
}

export interface Cycle {
  id: string;
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  enrollment_deadline: string | null;
  is_always_open: boolean;
  settings: CycleSettings;
  status: 'draft' | 'open' | 'closed' | 'archived';
  type: 'registration' | 'cyclus' | 'event';
  location_id: string | null;
  price_per_session: number | null;
  total_price: number | null;
  currency: string;
  terms: string | null;
  price_table: PriceTableRow[] | null;
  created_at: string;
  updated_at: string;
  // Joined data (optional)
  location?: { id: string; name: string; city: string } | null;
  _intakeCount?: number;
}

export interface ScoringWeights {
  time_match: number;
  preferred_trainer: number;
  level_compatible: number;
  priority_bonus: number;
  capacity_available: number;
  sessions_per_week: number;
}

export interface ExtraCost {
  description: string;
  price: number;
  type?: 'per_session' | 'one_time';
  vat_rate?: number;
}

export interface CyclusOption {
  label: string;
  number_of_sessions: number;
  number_of_weeks: number;
  price_per_session: number;
  total_price: number;
}

export type EventPaymentMethod = 'online' | 'cash' | 'both';

export interface CycleSettings {
  lesson_types?: ('private' | 'duo' | 'group' | 'group3' | 'group4' | 'kids')[];
  custom_lesson_types?: string[];
  show_preferred_trainer?: boolean;
  show_price_indication?: boolean;
  default_duration_minutes?: number;
  max_group_size?: number;
  min_group_size?: number;
  assigned_trainer_id?: string;
  min_skill_rating?: number;
  max_skill_rating?: number;
  rating_system?: string;
  applicable_trainer_ids?: string[];
  scoring_weights?: ScoringWeights;
  max_rating_spread?: number;
  rating_spread_system?: string;
  allow_single_booking?: boolean;
  /** Whole-series checkout allowed? Absent/true = bookable (PR #360); false = individual sessions only. */
  allow_cyclus_booking?: boolean;
  extra_costs?: ExtraCost[];
  mark_as_paid?: boolean;
  payment_timing?: 'upfront' | 'invoice_after_weeks' | 'manual';
  invoice_delay_weeks?: number;
  split_payment?: boolean;
  // Quick slot/cycle generator (additive — see src/lib/slotGenerator.ts).
  /** Provenance marker: set on cycles created by the slot generator. */
  generated_by?: 'slot_generator';
  /** Owner's public/private intent; applied to slots on publish (draft slots stay is_public=false). */
  publish_visibility?: 'public' | 'private';
  /** Phase-B-inert: a public cycle that requires upfront payment before a slot is reserved. */
  requires_upfront_payment?: boolean;
  // Event-specific settings
  payment_methods?: EventPaymentMethod;
  event_dates?: string[];
  max_participants?: number;
  // Custom success message shown after registration
  success_message?: string;
  // Custom text included in the confirmation email sent after registration
  confirmation_email_text?: string;
  // Cyclus options (packages) for registration
  cyclus_options?: CyclusOption[];
  // Duration options (in weeks) players can choose from
  duration_options?: number[];
  // Available lesson duration options (in minutes) players can choose from
  available_duration_minutes?: number[];
  // Named price columns for the price table (e.g. ["Jeugd", "Volwassenen"])
  price_columns?: string[];
  // Whether the displayed prices include VAT
  prices_include_vat?: boolean;
  // Stored trainer availability windows from the proposal wizard
  trainer_availability_windows?: TrainerAvailabilityWindow[];
  // Pre-selected days & time frames available for registration
  available_days?: Record<string, { start: string; end: string }[]>;
  // Dates to exclude from recurring schedule (holidays, etc.)
  excluded_dates?: string[];
  [key: string]: unknown; // Allow for Json compatibility
}

export interface TrainerAvailabilityWindow {
  trainerId: string;
  trainerName: string;
  trainerAvatar?: string | null;
  windows: { day: string; start: string; end: string }[];
}

export interface IntakeRequest {
  id: string;
  cycle_id: string;
  player_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  rating: number | null;
  rating_system: string;
  lesson_type: 'private' | 'duo' | 'group' | 'group3' | 'group4' | 'kids';
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_duration_minutes: number;
  sessions_per_week: number;
  preferred_trainer_ids: string[];
  location_id: string | null;
  birth_date: string | null;
  notes: string | null;
  consent_given: boolean;
  status: 'new' | 'proposed' | 'confirmed' | 'rejected' | 'waitlist';
  skip_reason?: 'no_matching_slots' | 'all_slots_full' | 'no_available_trainers' | 'rating_outside_trainer_range' | 'rating_spread_exceeded' | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Payment — registration/event cycles are invoiced; null when no payment is configured.
  invoice_id?: string | null;
  payment_method?: string | null;
  invoice_status?: string | null;
}

export interface ProposalDetails {
  slot_day: string;      // e.g., "Monday"
  slot_time: string;     // e.g., "12:00 - 13:00"
  slot_date: string;     // e.g., "Feb 16"
  slot_start: string;    // ISO timestamp
  slot_end: string;      // ISO timestamp
  trainer_id: string;
  trainer_name: string;
  trainer_avatar?: string | null;
  confidence_score: number;
  group_members: string[];  // Other players in same slot
}

export interface IntakeRequestWithProposal extends IntakeRequest {
  proposal?: ProposalDetails;
}

export interface RationaleItem {
  type: string;
  score: number;
  detail: string;
}

export interface ProposedAssignment {
  id: string;
  intake_request_id: string;
  slot_id: string;
  trainer_id: string;
  status: 'proposed' | 'approved' | 'rejected' | 'confirmed';
  confidence_score: number | null;
  rationale: RationaleItem[] | null;
  created_at: string;
  updated_at: string;
}

export interface EnrichedProposedAssignment extends ProposedAssignment {
  slot?: {
    id: string;
    start_time: string;
    end_time: string;
    location_id: string | null;
    cyclus_name?: string | null;
    max_participants?: number | null;
  };
  trainer?: {
    id: string;
    profile?: { full_name: string; avatar_url: string | null } | null;
  };
}

export interface TimeWindow {
  day: string;
  start: string;
  end: string;
}

export interface IntakeRequestInput {
  cycle_id: string;
  player_id: string;
  full_name: string;
  email: string;
  phone?: string;
  birth_date?: string;
  rating?: number;
  rating_system?: string;
  lesson_types: string[];
  preferred_days: string[];
  preferred_time_windows: TimeWindow[];
  preferred_duration_minutes?: number;
  sessions_per_week?: number;
  preferred_trainer_ids?: string[];
  location_id?: string;
  notes?: string;
  consent_given?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CycleInput {
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  name: string;
  description?: string;
  start_date?: string | null;
  end_date?: string | null;
  enrollment_deadline?: string | null;
  is_always_open?: boolean;
  settings?: CycleSettings;
  status?: 'draft' | 'open' | 'closed' | 'archived';
  type?: 'registration' | 'cyclus' | 'event';
  location_id?: string | null;
  price_per_session?: number | null;
  total_price?: number | null;
  currency?: string;
  terms?: string | null;
  price_table?: PriceTableRow[] | null;
}

/** A partial slot edit. Only the fields you set are written; an explicit `null` clears the column.
 *  `startShiftMinutes` + `durationMinutes` go together (relative time shift; omit one and neither
 *  applies). Price fields are intentionally absent — edit those via {@link updateCyclePricing}. */
export interface SlotEditPatch {
  startShiftMinutes?: number;
  durationMinutes?: number;
  trainerId?: string | null;
  locationId?: string | null;
  maxParticipants?: number | null;
  ratingSystem?: string | null;
  minRating?: number | null;
  maxRating?: number | null;
  cyclusName?: string | null;
  isPublic?: boolean;
}

export interface SlotEditResult {
  /** Slots actually updated. */
  updatedCount: number;
  /** Slots that blocked the edit because their occupancy exceeds the requested max_participants. */
  blockedCount: number;
  /** The blocking slot ids — surface them ("can't shrink: N players booked"); the edit was a no-op. */
  blockedSlotIds: string[];
}
