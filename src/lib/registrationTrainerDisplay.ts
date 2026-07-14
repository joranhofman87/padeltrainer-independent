// How the PUBLIC registration form treats trainers, from the form's settings + the loaded trainers.
// The admin picks a set (settings.applicable_trainer_ids). When non-empty, those trainers' PROFILES
// are shown so players see who their trainers are; a player only gets a PREFERENCE picker when the
// admin also turns on `show_preferred_trainer`. Empty set + the legacy `show_preferred_trainer` flag
// falls back to the pre-feature behaviour (show ALL trainers as a picker) so existing forms are
// unchanged — no data migration of old registration rows.

export interface RegTrainerOption {
  id: string;
  name: string;
  avatarUrl?: string | null;
  slug?: string | null;
  location?: string | null;
  specializations?: string[] | null;
}

export interface RegistrationTrainerDisplay {
  /** The trainers to render (filtered to the admin's set, or all as legacy fallback). */
  trainersToShow: RegTrainerOption[];
  /** Show the informational profile cards (only for the new "picked a set" path). */
  showProfileCards: boolean;
  /** Show the player-preference picker. */
  showPicker: boolean;
}

export function resolveRegistrationTrainerDisplay(
  settings: { applicable_trainer_ids?: string[] | null; show_preferred_trainer?: boolean } | null | undefined,
  loadedTrainers: RegTrainerOption[],
): RegistrationTrainerDisplay {
  const applicable = settings?.applicable_trainer_ids ?? [];
  const hasSet = applicable.length > 0;
  const showPreferred = settings?.show_preferred_trainer === true;

  const trainersToShow = hasSet
    ? loadedTrainers.filter((t) => applicable.includes(t.id))
    : (showPreferred ? loadedTrainers : []); // legacy: empty set + toggle on = show all (picker only)

  return {
    trainersToShow,
    showProfileCards: hasSet && trainersToShow.length > 0, // NEW: cards only when an explicit set exists
    showPicker: showPreferred && trainersToShow.length > 0,
  };
}
