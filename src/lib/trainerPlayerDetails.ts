import { supabase } from '@/lib/supabaseClient';
import {
  AcademyPlayerDetailsForm,
  AcademyPlayerKind,
  AcademyPlayerDetailsValues,
  buildGuestPlayerUpdatePayload,
  buildLinkedGuestMirrorPayload,
  buildRegisteredProfileUpdatePayload,
  validatePlayerDetailsForm,
} from '@/lib/academyPlayerDetails';
import { validatePreferredLocationId } from '@/lib/academyPlayerTrainingLocations';
import { refuseOverlayWrite } from '@/lib/overlayWriteContainment';

export type TrainerPlayerDetailsValues = AcademyPlayerDetailsValues;

export async function fetchTrainerLocationOptions(
  trainerProfileId: string,
): Promise<{ id: string; name: string }[]> {
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select('location_id')
    .eq('trainer_id', trainerProfileId)
    .not('location_id', 'is', null);

  if (error) throw error;

  const locationIds = Array.from(
    new Set((slots || []).map((s) => s.location_id).filter((id): id is string => Boolean(id))),
  );
  if (!locationIds.length) return [];

  const { data: locs, error: locsError } = await supabase
    .from('locations')
    .select('id, name')
    .in('id', locationIds);

  if (locsError) throw locsError;
  return (locs || []).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * ABC-16 H0: trainer notes / tags / preferred club are temporarily read-only.
 *
 * The trainer-owned arm of `academy_player_metadata` has the same defect as the academy
 * arm — the policy proves the caller owns the ROW, never that the subject has any
 * relationship with that trainer — so it closes with it. See
 * `src/lib/overlayWriteContainment.ts`. Reads are untouched.
 */
export async function saveTrainerPlayerMetadataFields(_params: {
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  notes: string | null;
  preferredLocationId?: string | null;
  tagIds?: string[];
}): Promise<never> {
  refuseOverlayWrite('notes');
}

export async function saveTrainerPlayerDetails(params: {
  kind: AcademyPlayerKind;
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  form: AcademyPlayerDetailsForm;
  allowedLocationIds: ReadonlySet<string>;
  tagIds?: string[];
}): Promise<void> {
  const validationError = validatePlayerDetailsForm(params.form, params.allowedLocationIds);
  if (validationError) {
    throw new Error(validationError);
  }

  // Still validated — it throws on a free-text or out-of-trainer club, and a rejected value
  // must not look accepted. H0 has no writer for the preferred club (registered branch below).
  validatePreferredLocationId(params.form.locationId, params.allowedLocationIds);

  if (params.kind === 'guest' && params.guestPlayerId) {
    if (params.profileId) {
      // Linked guest: the GUEST row is canonical for person identity (FAM-02
      // owner decision). A linked profile can belong to a different person —
      // a child's record linked to the parent's account via the shared family
      // email — so writing the form's identity to the profile would rename
      // the account holder. Only the guest row is written; email untouched.
      const guestPayload = buildLinkedGuestMirrorPayload(params.form, params.allowedLocationIds);
      const { error: guestError } = await supabase
        .from('guest_players')
        .update(guestPayload)
        .eq('id', params.guestPlayerId)
        .eq('trainer_id', params.trainerProfileId);
      if (guestError) throw guestError;
      return;
    }

    const payload = buildGuestPlayerUpdatePayload(params.form, params.allowedLocationIds);
    const { error } = await supabase
      .from('guest_players')
      .update(payload)
      .eq('id', params.guestPlayerId)
      .eq('trainer_id', params.trainerProfileId);
    if (error) throw error;
    return;
  }

  if (params.kind === 'registered' && params.profileId) {
    const profilePayload = buildRegisteredProfileUpdatePayload(params.form);
    if ('email' in profilePayload || 'location' in profilePayload) {
      throw new Error('registeredRestrictedFieldUpdateForbidden');
    }
    const { error: profileError } = await supabase
      .from('profiles')
      .update(profilePayload)
      .eq('id', params.profileId);
    if (profileError) throw profileError;

    // ABC-16 H0: the overlay write that used to follow this profile write is removed rather
    // than left to refuse. It runs AFTER a committed profile change, so throwing here would
    // report the whole save as failed while the name and level really did change. The
    // overlay controls render read-only instead.
    return;
  }

  throw new Error('invalidPlayer');
}
