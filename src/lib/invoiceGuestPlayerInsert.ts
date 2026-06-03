import { resolveRegistrationNameFields } from '@/lib/profileName';

/** Name fields for guest_players created from invoice receiver full name. */
export function invoiceGuestNameFields(playerName: string) {
  return resolveRegistrationNameFields({ full_name: playerName.trim() });
}

/** Academy-scoped guest_players insert from manual/custom invoice forms. */
export function buildAcademyInvoiceGuestInsert(
  playerName: string,
  playerEmail: string,
  academyProfileId: string,
) {
  return {
    ...invoiceGuestNameFields(playerName),
    email: playerEmail.trim(),
    academy_profile_id: academyProfileId,
  };
}

/** Trainer-scoped guest_players insert from manual invoice form. */
export function buildTrainerInvoiceGuestInsert(
  playerName: string,
  playerEmail: string,
  trainerId: string,
) {
  return {
    ...invoiceGuestNameFields(playerName),
    email: playerEmail.trim(),
    trainer_id: trainerId,
  };
}
