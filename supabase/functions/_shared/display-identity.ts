// The ONE canonical display-identity resolver for a booking's player, used everywhere a
// booking's "who" is shown — staff emails, Slack pings, confirmations.
//
// GUEST-FIRST (FAM-02): a booking carrying a guest belongs to that guest PERSON, so the guest's
// name is the identity to display — never a linked parent/profile name. Choosing the profile
// first (the old bug in the staff-facing paths) leaked the wrong person: a trainer or academy
// manager saw the PARENT's name on a child/guest booking. This function exists so that decision
// is made in exactly one place and cannot drift between call sites.

type NamedBooking = {
  profiles?: { full_name?: string | null } | null;
  guest_players?: { full_name?: string | null } | null;
} | null | undefined;

export function canonicalPlayerName(booking: NamedBooking, fallback = "Speler"): string {
  const guest = booking?.guest_players?.full_name?.trim();
  if (guest) return guest;   // guest-first: a guest booking is the guest's, regardless of any linked profile
  const profile = booking?.profiles?.full_name?.trim();
  if (profile) return profile;
  return fallback;
}
