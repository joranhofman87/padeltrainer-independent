import { supabase } from '@/lib/supabaseClient';
import { buildGuestPlayerDbFields, splitFullName, buildFullName } from '@/lib/profileName';
import { validatePreferredLocationId } from '@/lib/academyPlayerTrainingLocations';

export type AcademyPlayerKind = 'guest' | 'registered';

export type AcademyPlayerDetailsForm = {
  name: string;
  email: string;
  locationId: string;
  skillRating: string;
  ratingSystem: string;
  notes: string;
};

export type AcademyPlayerDetailsValues = {
  name: string;
  email: string | null;
  locationId: string | null;
  skillRating: number | null;
  ratingSystem: string;
  notes: string | null;
};

export function canEditRegisteredPlayerEmail(): boolean {
  return false;
}

export function validatePlayerDetailsForm(
  form: AcademyPlayerDetailsForm,
  allowedLocationIds?: ReadonlySet<string>,
): string | null {
  if (!form.name.trim()) {
    return 'nameRequired';
  }
  if (form.skillRating.trim()) {
    const rating = parseFloat(form.skillRating);
    if (Number.isNaN(rating) || rating < 1 || rating > 10) {
      return 'skillOutOfRange';
    }
  }
  if (allowedLocationIds && form.locationId.trim()) {
    try {
      validatePreferredLocationId(form.locationId, allowedLocationIds);
    } catch {
      return 'invalidLocationId';
    }
  }
  return null;
}

export function buildGuestPlayerUpdatePayload(
  form: AcademyPlayerDetailsForm,
  allowedLocationIds: ReadonlySet<string>,
) {
  const preferredLocationId = validatePreferredLocationId(form.locationId, allowedLocationIds);
  const { first_name, last_name } = splitFullName(form.name);
  return {
    ...buildGuestPlayerDbFields(first_name, last_name),
    email: form.email.trim().toLowerCase() || null,
    preferred_location_id: preferredLocationId,
    skill_rating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
    rating_system: form.ratingSystem || 'knltb',
    notes: form.notes.trim() || null,
  };
}

/** Allowed profile fields for claimed/registered players. Email and location are excluded. */
export const REGISTERED_PROFILE_UPDATE_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'skill_rating',
  'rating_system',
] as const;

export function buildRegisteredProfileUpdatePayload(form: AcademyPlayerDetailsForm) {
  const { first_name, last_name } = splitFullName(form.name);
  const fullName = buildFullName(first_name, last_name) || form.name.trim();
  const payload = {
    first_name: first_name || null,
    last_name: last_name || null,
    full_name: fullName,
    skill_rating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
    rating_system: form.ratingSystem || 'knltb',
  };

  if ('email' in payload || 'location' in payload) {
    throw new Error('registeredRestrictedFieldUpdateForbidden');
  }

  return payload;
}

export function formFromValues(values: AcademyPlayerDetailsValues): AcademyPlayerDetailsForm {
  return {
    name: values.name,
    email: values.email ?? '',
    locationId: values.locationId ?? '',
    skillRating: values.skillRating != null ? String(values.skillRating) : '',
    ratingSystem: values.ratingSystem || 'knltb',
    notes: values.notes ?? '',
  };
}

export async function saveAcademyPlayerMetadataFields(params: {
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  notes: string | null;
  preferredLocationId?: string | null;
  tagIds?: string[];
}) {
  const baseQuery = supabase
    .from('academy_player_metadata')
    .select('id')
    .eq('academy_profile_id', params.academyProfileId);

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
      .update(metadataFields as any)
      .eq('id', existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from('academy_player_metadata').insert({
    academy_profile_id: params.academyProfileId,
    guest_player_id: params.guestPlayerId,
    profile_id: params.profileId,
    tag_ids: params.tagIds ?? [],
    ...metadataFields,
  } as any);
  if (error) throw error;
}

export async function saveAcademyPlayerDetails(params: {
  kind: AcademyPlayerKind;
  academyProfileId: string;
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
      .eq('id', params.guestPlayerId);
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

    await saveAcademyPlayerMetadataFields({
      academyProfileId: params.academyProfileId,
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
