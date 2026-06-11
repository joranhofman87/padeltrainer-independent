import { buildAcademyInvoiceGuestInsert, buildTrainerInvoiceGuestInsert } from '@/lib/invoiceGuestPlayerInsert';
import { joinBillingAddress } from '@/lib/invoiceCustomer';
import type { InvoicePlayerLink, InvoiceReceiverFormFields } from '@/lib/invoiceCustomer';
import { supabase } from '@/lib/supabaseClient';

/** Reuse an existing guest row by email within academy/trainer scope before inserting. */
export async function findExistingGuestPlayerIdForInvoice(
  email: string,
  scope: 'academy' | 'trainer',
  academyProfileId?: string,
  trainerId?: string,
): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;

  if (scope === 'trainer' && trainerId) {
    const { data } = await supabase
      .from('guest_players')
      .select('id')
      .eq('trainer_id', trainerId)
      .eq('email', trimmed)
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }

  if (scope === 'academy' && academyProfileId) {
    const { data: academyTrainers } = await supabase
      .from('academy_trainers')
      .select('trainer_profile_id')
      .eq('academy_profile_id', academyProfileId)
      .eq('status', 'active');

    const trainerIds = (academyTrainers || []).map((t) => t.trainer_profile_id).filter(Boolean);

    let query = supabase.from('guest_players').select('id').eq('email', trimmed);
    if (trainerIds.length > 0) {
      query = query.or(
        `academy_profile_id.eq.${academyProfileId},trainer_id.in.(${trainerIds.join(',')})`,
      );
    } else {
      query = query.eq('academy_profile_id', academyProfileId);
    }

    const { data } = await query.limit(1).maybeSingle();
    return data?.id ?? null;
  }

  return null;
}

export type ResolveInvoiceGuestPlayerArgs = {
  playerLink: InvoicePlayerLink;
  oneTimeMode: boolean;
  receiver: InvoiceReceiverFormFields;
  scope: 'academy' | 'trainer';
  academyProfileId?: string;
  trainerId?: string;
};

/** Resolves guest_player_id for insert; never overwrites an existing linked guest. */
export async function resolveInvoiceGuestPlayerId(
  args: ResolveInvoiceGuestPlayerArgs,
): Promise<string | null> {
  const { playerLink, receiver, scope, academyProfileId, trainerId } = args;

  if (playerLink.guestPlayerId) {
    return playerLink.guestPlayerId;
  }

  if (playerLink.profileId) {
    return null;
  }

  if (!receiver.playerEmail.trim()) {
    return null;
  }

  const insert =
    scope === 'academy' && academyProfileId
      ? buildAcademyInvoiceGuestInsert(receiver.playerName, receiver.playerEmail, academyProfileId)
      : scope === 'trainer' && trainerId
        ? buildTrainerInvoiceGuestInsert(receiver.playerName, receiver.playerEmail, trainerId)
        : null;

  if (!insert) return null;

  const existingId = await findExistingGuestPlayerIdForInvoice(
    receiver.playerEmail,
    scope,
    academyProfileId,
    trainerId,
  );
  if (existingId) return existingId;

  const { data: guestPlayer, error } = await supabase
    .from('guest_players')
    .insert(insert)
    .select('id')
    .single();

  if (error || !guestPlayer) return null;
  return guestPlayer.id;
}

export function buildInvoicePlayerAddress(receiver: InvoiceReceiverFormFields): string | null {
  return joinBillingAddress(receiver.playerStreet, receiver.playerZipCode, receiver.playerCity);
}
