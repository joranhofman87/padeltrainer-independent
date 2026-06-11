import { joinBillingAddress } from '@/lib/invoiceCustomer';
import type { InvoicePlayerLink, InvoiceReceiverFormFields } from '@/lib/invoiceCustomer';
import { findExistingGuestPlayerIdByEmail, resolveOrCreateGuestPlayer } from '@/lib/playerResolve';
import type { GuestResolveScope } from '@/lib/playerResolve';

function toGuestResolveScope(
  scope: 'academy' | 'trainer',
  academyProfileId?: string,
  trainerId?: string,
): GuestResolveScope | null {
  if (scope === 'trainer' && trainerId) return { kind: 'trainer', trainerId };
  if (scope === 'academy' && academyProfileId) return { kind: 'academy', academyProfileId };
  return null;
}

/** Reuse an existing guest row by email within academy/trainer scope before inserting. */
export async function findExistingGuestPlayerIdForInvoice(
  email: string,
  scope: 'academy' | 'trainer',
  academyProfileId?: string,
  trainerId?: string,
): Promise<string | null> {
  const resolveScope = toGuestResolveScope(scope, academyProfileId, trainerId);
  if (!resolveScope) return null;
  return findExistingGuestPlayerIdByEmail(email, resolveScope);
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
  const resolveScope = toGuestResolveScope(args.scope, args.academyProfileId, args.trainerId);
  if (!resolveScope) return null;
  return resolveOrCreateGuestPlayer({
    scope: resolveScope,
    fullName: args.playerName,
    email: args.playerEmail,
  });
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
