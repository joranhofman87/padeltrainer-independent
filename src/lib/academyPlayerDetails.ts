import { supabase } from '@/lib/supabaseClient';
import { buildGuestPlayerDbFields, splitFullName, buildFullName } from '@/lib/profileName';
import { validatePreferredLocationId } from '@/lib/academyPlayerTrainingLocations';
import { refuseOverlayWrite } from '@/lib/overlayWriteContainment';

export type AcademyPlayerKind = 'guest' | 'registered';

export type AcademyPlayerDetailsForm = {
  name: string;
  email: string;
  phone: string;
  locationId: string;
  skillRating: string;
  ratingSystem: string;
  notes: string;
};

export type AcademyPlayerDetailsValues = {
  name: string;
  email: string | null;
  phone: string | null;
  locationId: string | null;
  skillRating: number | null;
  ratingSystem: string;
  notes: string | null;
};

export function canEditRegisteredPlayerEmail(): boolean {
  return false;
}

/**
 * Linked guest = guest_players row with linked_profile_id set. The profile is
 * canonical for identity (name/phone/skill/rating system/email); the guest row
 * keeps the relationship data (notes, source, preferred location, ...).
 */
export function isLinkedGuest(
  kind: AcademyPlayerKind,
  guestPlayerId: string | null,
  profileId: string | null,
): boolean {
  return kind === 'guest' && Boolean(guestPlayerId) && Boolean(profileId);
}

export type LinkedProfileIdentity = {
  full_name: string | null;
  email: string | null;
  phone: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  birth_date: string | null;
};

export type GuestIdentityFields = {
  full_name: string;
  email: string | null;
  phone: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  birth_date: string | null;
};

/** Fetch the canonical identity fields of a linked profile (null when not readable). */
export async function fetchLinkedProfileIdentity(
  profileId: string,
): Promise<LinkedProfileIdentity | null> {
  const { data } = await supabase
    .from('profiles')
    .select('full_name, email, phone, skill_rating, rating_system, birth_date')
    .eq('id', profileId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Canonical read for linked guests — same precedence as the get_players_overview
 * RPC. Families share one email, so a linked profile can belong to a DIFFERENT
 * person (a child's guest record linked to the parent's account); person
 * identity (name, rating, rating system, birth date) is therefore guest-first
 * with profile fallback, while account-level contact fields (email, phone)
 * stay profile-first. Relationship fields (notes, source, preferred location)
 * are not handled here and stay on the guest row.
 */
export function coalesceLinkedGuestIdentity(
  guest: GuestIdentityFields,
  profile: LinkedProfileIdentity | null,
): GuestIdentityFields {
  if (!profile) return guest;
  return {
    full_name: guest.full_name?.trim() || profile.full_name || guest.full_name,
    email: profile.email?.trim() || guest.email,
    phone: profile.phone?.trim() || guest.phone,
    skill_rating: guest.skill_rating ?? profile.skill_rating,
    rating_system: guest.rating_system?.trim() || profile.rating_system,
    birth_date: guest.birth_date ?? profile.birth_date,
  };
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
    phone: form.phone.trim() || null,
    preferred_location_id: preferredLocationId,
    skill_rating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
    rating_system: form.ratingSystem || 'knltb',
    notes: form.notes.trim() || null,
  };
}

/**
 * Guest-row mirror for linked guests: identity fields (keeps legacy raw-guest
 * readers consistent) plus the relationship fields that already live on the
 * guest row. Email is intentionally excluded so
 * trg_link_guest_data_on_guest_player_change never fires on an email change.
 */
export function buildLinkedGuestMirrorPayload(
  form: AcademyPlayerDetailsForm,
  allowedLocationIds: ReadonlySet<string>,
) {
  const preferredLocationId = validatePreferredLocationId(form.locationId, allowedLocationIds);
  const { first_name, last_name } = splitFullName(form.name);
  return {
    ...buildGuestPlayerDbFields(first_name, last_name),
    phone: form.phone.trim() || null,
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
  'phone',
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
    phone: form.phone.trim() || null,
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
    phone: values.phone ?? '',
    locationId: values.locationId ?? '',
    skillRating: values.skillRating != null ? String(values.skillRating) : '',
    ratingSystem: values.ratingSystem || 'knltb',
    notes: values.notes ?? '',
  };
}

/**
 * ABC-16 H0: academy notes / tags / preferred club are temporarily read-only.
 *
 * This writer set `academy_player_metadata` for a caller-chosen subject, and that same row
 * was what three authorization predicates accepted as proof of the academy↔player
 * relationship. Until an H1 command derives the subject from canonical membership
 * server-side there is no client writer — see `src/lib/overlayWriteContainment.ts`.
 * Reads are untouched: the values still load and still render.
 */
export async function saveAcademyPlayerMetadataFields(_params: {
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  notes: string | null;
  preferredLocationId?: string | null;
  tagIds?: string[];
}): Promise<never> {
  refuseOverlayWrite('notes');
}

export async function saveAcademyPlayerDetails(params: {
  kind: AcademyPlayerKind;
  academyProfileId: string;
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

  // Still validated — it throws on a free-text or out-of-academy club, and a rejected
  // value must not look accepted. H0 has no writer for the preferred club, so the result
  // is not persisted for a registered player (see the registered branch below).
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
        .eq('id', params.guestPlayerId);
      if (guestError) throw guestError;
      return;
    }

    const payload = buildGuestPlayerUpdatePayload(params.form, params.allowedLocationIds);
    const { error } = await supabase
      .from('guest_players')
      .update(payload)
      .eq('id', params.guestPlayerId);
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

    // ABC-16 H0: the academy-scoped overlay fields (notes, tags, preferred club) used to be
    // written here, right after the profile. That call is removed rather than left to
    // refuse: it runs AFTER a profile write that has already committed, so letting it throw
    // would report the whole save as failed while the player's name and level really did
    // change. The overlay controls are rendered read-only instead, so nothing that reaches
    // this function is silently dropped.
    return;
  }

  throw new Error('invalidPlayer');
}
