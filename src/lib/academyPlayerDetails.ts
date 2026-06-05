import { supabase } from '@/lib/supabaseClient';
import { buildGuestPlayerDbFields, splitFullName, buildFullName } from '@/lib/profileName';

export type AcademyPlayerKind = 'guest' | 'registered';

export type AcademyPlayerDetailsForm = {
  name: string;
  email: string;
  locationId: string;
  locationName: string;
  skillRating: string;
  ratingSystem: string;
  notes: string;
};

export type AcademyPlayerDetailsValues = {
  name: string;
  email: string | null;
  locationId: string | null;
  locationName: string | null;
  skillRating: number | null;
  ratingSystem: string;
  notes: string | null;
};

export function canEditRegisteredPlayerEmail(): boolean {
  return false;
}

export function validatePlayerDetailsForm(form: AcademyPlayerDetailsForm): string | null {
  if (!form.name.trim()) {
    return 'nameRequired';
  }
  if (form.skillRating.trim()) {
    const rating = parseFloat(form.skillRating);
    if (Number.isNaN(rating) || rating < 1 || rating > 10) {
      return 'skillOutOfRange';
    }
  }
  return null;
}

export function buildGuestPlayerUpdatePayload(form: AcademyPlayerDetailsForm) {
  const { first_name, last_name } = splitFullName(form.name);
  return {
    ...buildGuestPlayerDbFields(first_name, last_name),
    email: form.email.trim().toLowerCase() || null,
    preferred_location_id: form.locationId || null,
    skill_rating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
    rating_system: form.ratingSystem || 'knltb',
    notes: form.notes.trim() || null,
  };
}

/** Allowed profile fields for claimed/registered players. Email is intentionally excluded. */
export const REGISTERED_PROFILE_UPDATE_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'location',
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
    location: form.locationName.trim() || null,
    skill_rating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
    rating_system: form.ratingSystem || 'knltb',
  };

  if ('email' in payload) {
    throw new Error('registeredEmailUpdateForbidden');
  }

  return payload;
}

export function formFromValues(values: AcademyPlayerDetailsValues): AcademyPlayerDetailsForm {
  return {
    name: values.name,
    email: values.email ?? '',
    locationId: values.locationId ?? '',
    locationName: values.locationName ?? '',
    skillRating: values.skillRating != null ? String(values.skillRating) : '',
    ratingSystem: values.ratingSystem || 'knltb',
    notes: values.notes ?? '',
  };
}

export async function saveAcademyPlayerMetadataNotes(params: {
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  notes: string | null;
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

  if (existing) {
    const { error } = await supabase
      .from('academy_player_metadata')
      .update({
        notes: params.notes,
        ...(params.tagIds ? { tag_ids: params.tagIds } : {}),
      })
      .eq('id', existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from('academy_player_metadata').insert({
    academy_profile_id: params.academyProfileId,
    guest_player_id: params.guestPlayerId,
    profile_id: params.profileId,
    notes: params.notes,
    tag_ids: params.tagIds ?? [],
  } as any);
  if (error) throw error;
}

export async function saveAcademyPlayerDetails(params: {
  kind: AcademyPlayerKind;
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  form: AcademyPlayerDetailsForm;
  tagIds?: string[];
}) {
  const validationError = validatePlayerDetailsForm(params.form);
  if (validationError) {
    throw new Error(validationError);
  }

  if (params.kind === 'guest' && params.guestPlayerId) {
    const payload = buildGuestPlayerUpdatePayload(params.form);
    const { error } = await supabase
      .from('guest_players')
      .update(payload)
      .eq('id', params.guestPlayerId);
    if (error) throw error;
    return payload;
  }

  if (params.kind === 'registered' && params.profileId) {
    // Claimed accounts are global: never persist email changes from academy UI.
    const profilePayload = buildRegisteredProfileUpdatePayload(params.form);
    if ('email' in profilePayload) {
      throw new Error('registeredEmailUpdateForbidden');
    }
    const { error: profileError } = await supabase
      .from('profiles')
      .update(profilePayload)
      .eq('id', params.profileId);
    if (profileError) throw profileError;

    await saveAcademyPlayerMetadataNotes({
      academyProfileId: params.academyProfileId,
      guestPlayerId: null,
      profileId: params.profileId,
      notes: params.form.notes.trim() || null,
      tagIds: params.tagIds,
    });

    return profilePayload;
  }

  throw new Error('invalidPlayer');
}
