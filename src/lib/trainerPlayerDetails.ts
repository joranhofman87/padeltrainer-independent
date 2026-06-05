import { supabase } from '@/lib/supabaseClient';
import {
  AcademyPlayerDetailsForm,
  AcademyPlayerKind,
  AcademyPlayerDetailsValues,
  buildGuestPlayerUpdatePayload,
  buildRegisteredProfileUpdatePayload,
  validatePlayerDetailsForm,
} from '@/lib/academyPlayerDetails';
import { validatePreferredLocationId } from '@/lib/academyPlayerTrainingLocations';

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

export async function saveTrainerPlayerMetadataFields(params: {
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  notes: string | null;
  preferredLocationId?: string | null;
  tagIds?: string[];
}) {
  const baseQuery = supabase
    .from('academy_player_metadata')
    .select('id')
    .eq('trainer_profile_id', params.trainerProfileId);

  const { data: existing } = await (params.guestPlayerId
    ? baseQuery.eq('guest_player_id', params.guestPlayerId)
    : baseQuery.eq('profile_id', params.profileId!)
  ).maybeSingle();

  const metadataFields = {
    notes: params.notes,
    preferred_location_id: params.preferredLocationId ?? null,
    ...(params.tagIds ? { tag_ids: params.tagIds } : {}),
  };

  if (existing) {
    const { error } = await supabase
      .from('academy_player_metadata')
      .update(metadataFields as Record<string, unknown>)
      .eq('id', existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from('academy_player_metadata').insert({
    trainer_profile_id: params.trainerProfileId,
    guest_player_id: params.guestPlayerId,
    profile_id: params.profileId,
    tag_ids: params.tagIds ?? [],
    ...metadataFields,
  } as Record<string, unknown>);
  if (error) throw error;
}

export async function saveTrainerPlayerDetails(params: {
  kind: AcademyPlayerKind;
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  form: AcademyPlayerDetailsForm;
  allowedLocationIds: ReadonlySet<string>;
  tagIds?: string[];
}) {
  const validationError = validatePlayerDetailsForm(params.form, params.allowedLocationIds);
  if (validationError) {
    throw new Error(validationError);
  }

  const preferredLocationId = validatePreferredLocationId(
    params.form.locationId,
    params.allowedLocationIds,
  );

  if (params.kind === 'guest' && params.guestPlayerId) {
    const payload = buildGuestPlayerUpdatePayload(params.form, params.allowedLocationIds);
    const { error } = await supabase
      .from('guest_players')
      .update(payload)
      .eq('id', params.guestPlayerId)
      .eq('trainer_id', params.trainerProfileId);
    if (error) throw error;
    return payload;
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

    await saveTrainerPlayerMetadataFields({
      trainerProfileId: params.trainerProfileId,
      guestPlayerId: null,
      profileId: params.profileId,
      notes: params.form.notes.trim() || null,
      preferredLocationId,
      tagIds: params.tagIds,
    });

    return { profilePayload, preferredLocationId };
  }

  throw new Error('invalidPlayer');
}
