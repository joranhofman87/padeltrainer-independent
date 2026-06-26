import { format } from 'date-fns';
import type { SlotEditFormSlot, SlotEditFormValues } from '@/components/slots/SlotEditForm';
import type { SlotEditPatch } from '@/lib/cycles';

/**
 * The form-initial values of the representative slot, used to diff a whole-cycle edit. Mirrors
 * SlotEditForm's own init (so an untouched field compares equal and is left out of the patch).
 */
export interface CycleEditBaseline {
  startTime: string; // HH:mm (local)
  duration: number; // minutes
  trainerId: string;
  locationId: string; // 'none' | uuid
  maxParticipants: number;
  ratingSystem: string | null;
  minRating: number | null;
  maxRating: number | null;
  cyclusName: string;
  isMarkedFull: boolean;
}

/** Derive the baseline from the representative slot — verbatim from SlotEditForm's init effect. */
export function slotEditBaselineFromSlot(slot: SlotEditFormSlot): CycleEditBaseline {
  const start = new Date(slot.start_time);
  const end = new Date(slot.end_time);
  return {
    startTime: format(start, 'HH:mm'),
    duration: Math.round((end.getTime() - start.getTime()) / 60000),
    trainerId: slot.trainer_id,
    locationId: slot.location_id || 'none',
    maxParticipants: slot.max_participants,
    ratingSystem: slot.rating_system,
    minRating: slot.min_rating,
    maxRating: slot.max_rating,
    cyclusName: slot.cyclus_name || '',
    isMarkedFull: !slot.is_public,
  };
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/**
 * Build the {@link SlotEditPatch} for a whole-cycle edit from the form values + the representative
 * slot's baseline. Only the fields the user actually CHANGED are included — omitted keys are kept
 * per-slot by `apply_slot_edit_to_cycle`, so unrelated slots aren't homogenised (a time-only edit
 * won't reshape another session's duration or trip its capacity guard).
 *
 * Notes faithful to the RPC contract:
 *  - Time is RELATIVE: `startShiftMinutes` is the time-of-day delta (new − old), applied to every
 *    slot; `durationMinutes` is absolute. They must travel together, so any change to either sends
 *    both (a pure resize sends `startShiftMinutes: 0`).
 *  - Price fields are intentionally absent (pricing is the cycle-pricing path).
 *  - `trainerId` is only sent when it changed to a real id — clearing it (null) is a no-op for the
 *    RPC anyway, so we don't bother sending it.
 */
export function buildCycleEditPatch(values: SlotEditFormValues, baseline: CycleEditBaseline): SlotEditPatch {
  const patch: SlotEditPatch = {};

  if (values.startTime !== baseline.startTime || values.duration !== baseline.duration) {
    patch.startShiftMinutes = toMinutes(values.startTime) - toMinutes(baseline.startTime);
    patch.durationMinutes = values.duration;
  }
  if (values.trainerId !== baseline.trainerId && values.trainerId) {
    patch.trainerId = values.trainerId;
  }
  const newLocation = values.locationId === 'none' ? null : values.locationId;
  const baseLocation = baseline.locationId === 'none' ? null : baseline.locationId;
  if (newLocation !== baseLocation) patch.locationId = newLocation;
  if (values.maxParticipants !== baseline.maxParticipants) patch.maxParticipants = values.maxParticipants;
  if (values.ratingSystem !== baseline.ratingSystem) patch.ratingSystem = values.ratingSystem;
  if (values.minRating !== baseline.minRating) patch.minRating = values.minRating;
  if (values.maxRating !== baseline.maxRating) patch.maxRating = values.maxRating;
  if (values.cyclusName !== baseline.cyclusName) patch.cyclusName = values.cyclusName;
  if (values.isMarkedFull !== baseline.isMarkedFull) patch.isPublic = !values.isMarkedFull;

  return patch;
}
