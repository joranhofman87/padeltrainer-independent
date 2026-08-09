import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { joinBillingAddress } from '@/lib/invoiceCustomer';
import type { InvoicePlayerLink, InvoiceReceiverFormFields } from '@/lib/invoiceCustomer';

/**
 * Resolving the Player an invoice is FOR.
 *
 * There are exactly two ways this is answered, and neither of them looks anybody up by name or
 * address (U2, owner 2026-08-09):
 *
 *   1. The operator picked a Player. The picker hands back that Player's id, and the id travels
 *      through to the invoice unchanged. A known recipient is never re-derived from what happens to
 *      be typed in the receiver fields.
 *   2. Nobody was picked — a one-off recipient typed by hand. That is a NEW Player, created through
 *      the one server-side command, idempotently on the caller's own attempt id. If the new Player
 *      looks like one the owner already has, the command files a duplicate proposal for a human to
 *      judge; it does not quietly bill the existing one.
 *
 * What used to happen instead: the typed address was looked up in `guest_players`, and a single hit
 * whose name agreed was reused. Households share an address, so "the name agrees" is a coin flip
 * between a parent and a child with the same surname — and the losing side of that flip is an
 * invoice sent to the wrong person.
 */

export type ResolveInvoiceGuestPlayerArgs = {
  playerLink: InvoicePlayerLink;
  oneTimeMode: boolean;
  receiver: InvoiceReceiverFormFields;
  scope: 'academy' | 'trainer';
  academyProfileId?: string;
  trainerId?: string;
  /** Stable id for THIS save attempt — see `creationRequestIdFor`. */
  creationRequestId: string;
};

export type ResolveOrCreateInvoiceGuestArgs = {
  playerName: string;
  playerEmail: string;
  scope: 'academy' | 'trainer';
  academyProfileId?: string;
  trainerId?: string;
  creationRequestId: string;
};

/** The material facts of one recipient, for keying the attempt id. */
export function invoiceRecipientKey(args: {
  playerName: string;
  playerEmail: string;
  scope: 'academy' | 'trainer';
  ownerId?: string;
}): string {
  return JSON.stringify([args.scope, args.ownerId ?? null, args.playerName.trim(), args.playerEmail.trim()]);
}

/**
 * Create the Player an invoice is addressed to. ALWAYS yields a Player when a name is present —
 * including one with no email address — so every invoice recipient appears in the players list,
 * which is the single source of truth.
 *
 * Returns the guest_players id, or null when there is nothing to create, no owner scope, or the
 * command refused. Null is non-blocking for the callers: the invoice is still written, unlinked,
 * and the failure is logged rather than losing the operator's work.
 */
export async function resolveOrCreateInvoiceGuest(
  args: ResolveOrCreateInvoiceGuestArgs,
): Promise<string | null> {
  const ownerId = args.scope === 'academy' ? args.academyProfileId : args.trainerId;
  if (!ownerId) return null;

  const fullName = args.playerName.trim();
  if (!fullName) return null;

  const { data, error } = await supabase.rpc('player_create_command', {
    _creation_request_id: args.creationRequestId,
    _owner_type: args.scope,
    _owner_id: ownerId,
    _full_name: fullName,
    _email: args.playerEmail.trim().toLowerCase() || null,
    _source: 'invoice_recipient',
    _origin: 'operator',
  });

  if (error) {
    logger.error('invoice recipient create failed', new Error(error.message), {
      scope: args.scope,
      errorCode: error.code,
    });
    return null;
  }
  return (data as { guest_player_id: string | null } | null)?.guest_player_id ?? null;
}

/** Resolves guest_player_id for insert; never overwrites an existing linked guest. */
export async function resolveInvoiceGuestPlayerId(
  args: ResolveInvoiceGuestPlayerArgs,
): Promise<string | null> {
  const { playerLink, receiver, scope, academyProfileId, trainerId, creationRequestId } = args;

  // (1) The operator picked this Player. Their id is the answer.
  if (playerLink.guestPlayerId) {
    return playerLink.guestPlayerId;
  }

  // A picked ACCOUNT is carried by the invoice's own `player_id` column, so there is no guest row
  // to resolve and nothing to create.
  if (playerLink.profileId) {
    return null;
  }

  // (2) A hand-typed recipient: a new Player.
  return resolveOrCreateInvoiceGuest({
    playerName: receiver.playerName,
    playerEmail: receiver.playerEmail,
    scope,
    academyProfileId,
    trainerId,
    creationRequestId,
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
  creationRequestId: string,
): Promise<string | null> {
  return resolveOrCreateInvoiceGuest({
    playerName,
    playerEmail,
    scope: 'academy',
    academyProfileId,
    creationRequestId,
  });
}
