import { invoiceGuestNameFields } from '@/lib/invoiceGuestPlayerInsert';
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

export type ResolveOrCreateInvoiceGuestArgs = {
  playerName: string;
  playerEmail: string;
  scope: 'academy' | 'trainer';
  academyProfileId?: string;
  trainerId?: string;
};

/**
 * Resolve-or-create a guest player for an invoice recipient (academy or trainer
 * scope). ALWAYS yields a player record when a name is present — creating an
 * emailless guest when no email is given — so every invoice recipient becomes a
 * player visible in the players list (the players table is the single source of
 * truth). Dedupes by email within scope to respect the unique partial indexes.
 *
 * Returns the guest_players id, or null if no name/owner was given or the
 * insert failed.
 */
export async function resolveOrCreateInvoiceGuest(
  args: ResolveOrCreateInvoiceGuestArgs,
): Promise<string | null> {
  const { scope, academyProfileId, trainerId } = args;
  const name = args.playerName.trim();
  if (!name) return null;
  const email = args.playerEmail.trim();

  const ownerFields =
    scope === 'academy' && academyProfileId
      ? { academy_profile_id: academyProfileId }
      : scope === 'trainer' && trainerId
        ? { trainer_id: trainerId }
        : null;
  if (!ownerFields) return null;

  if (email) {
    const existingId = await findExistingGuestPlayerIdForInvoice(
      email,
      scope,
      academyProfileId,
      trainerId,
    );
    if (existingId) return existingId;
  }

  const insert = email
    ? { ...invoiceGuestNameFields(name), email, ...ownerFields }
    : { ...invoiceGuestNameFields(name), ...ownerFields };

  const { data, error } = await supabase
    .from('guest_players')
    .insert(insert)
    .select('id')
    .single();

  if (error || !data) return null;
  return data.id;
}

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

  return resolveOrCreateInvoiceGuest({
    playerName: receiver.playerName,
    playerEmail: receiver.playerEmail,
    scope,
    academyProfileId,
    trainerId,
  });
}

export function buildInvoicePlayerAddress(receiver: InvoiceReceiverFormFields): string | null {
  return joinBillingAddress(receiver.playerStreet, receiver.playerZipCode, receiver.playerCity);
}

/** Academy convenience wrapper around resolveOrCreateInvoiceGuest. */
export async function resolveOrCreateAcademyInvoiceGuest(
  playerName: string,
  playerEmail: string,
  academyProfileId: string,
): Promise<string | null> {
  return resolveOrCreateInvoiceGuest({ playerName, playerEmail, scope: 'academy', academyProfileId });
}
