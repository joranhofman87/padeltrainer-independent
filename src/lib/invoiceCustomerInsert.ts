import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { joinBillingAddress } from '@/lib/invoiceCustomer';
import type { InvoicePlayerLink, InvoiceReceiverFormFields } from '@/lib/invoiceCustomer';
import type { Json } from '@/integrations/supabase/types';

/**
 * Resolving the Player an invoice is FOR — as a canonical `person_id`, and nothing else.
 *
 * There are exactly two ways this is answered, and neither of them looks anybody up by name or
 * address (U2, owner 2026-08-09):
 *
 *   1. The operator picked a Player. The picker row carries that Player's canonical id, and the id
 *      travels through to the invoice unchanged. A known recipient is never re-derived from what
 *      happens to be typed in the receiver fields.
 *   2. Nobody was picked — a one-off recipient typed by hand. That is a NEW Player, created through
 *      the one server-side command, idempotently on the caller's own attempt id. If the new Player
 *      looks like one the owner already has, the command files a duplicate proposal for a human to
 *      judge; it does not quietly bill the existing one.
 *
 * What this module deliberately NEVER handles is a legacy id (owner correction, 2026-08-09). The
 * create command answers with `person_id` only, and the invoice INSERT happens inside
 * `invoice_create_for_person`, which derives the legacy link columns server-side, in the same
 * transaction, from `person_links`. A browser that translated the person back into a guest id —
 * even "just for the insert" — would put the legacy id right back into state, logs and requests,
 * which is the leak this correction closes.
 */

export type ResolveInvoicePersonArgs = {
  playerLink: InvoicePlayerLink;
  oneTimeMode: boolean;
  receiver: InvoiceReceiverFormFields;
  scope: 'academy' | 'trainer';
  academyProfileId?: string;
  trainerId?: string;
  /** Stable id for THIS save attempt — see `creationRequestIdFor`. */
  creationRequestId: string;
};

export type ResolveOrCreateInvoicePersonArgs = {
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
 * Returns the canonical person id, or null when there is nothing to create, no owner scope, or the
 * command refused. Null is non-blocking for the callers: the invoice is still written, unlinked,
 * and the failure is logged rather than losing the operator's work.
 */
export async function resolveOrCreateInvoicePerson(
  args: ResolveOrCreateInvoicePersonArgs,
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
  return (data as { person_id: string | null } | null)?.person_id ?? null;
}

/** Resolves the canonical person the invoice links to; never re-derives a picked recipient. */
export async function resolveInvoicePersonId(
  args: ResolveInvoicePersonArgs,
): Promise<string | null> {
  const { playerLink, receiver, scope, academyProfileId, trainerId, creationRequestId } = args;

  // (1) The operator picked this Player. Their canonical id is the answer.
  if (playerLink.personId) {
    return playerLink.personId;
  }

  // A PICKED row (it has a display name) without a canonical id can only be a pre-unification
  // stray the backfill never touched. Creating a person for it HERE would double the human;
  // linking by a legacy id would resurrect the leak. The invoice is saved unlinked and the stray
  // is surfaced in the logs. Deliberately keyed on the display name, not on the legacy picker
  // keys — this module does not touch those fields at all.
  if (playerLink.linkedDisplayName) {
    logger.error('picked invoice recipient has no canonical person id', undefined, { scope });
    return null;
  }

  // (2) A hand-typed recipient: a new Player.
  return resolveOrCreateInvoicePerson({
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

/** Academy convenience wrapper around resolveOrCreateInvoicePerson. */
export async function resolveOrCreateAcademyInvoicePerson(
  playerName: string,
  playerEmail: string,
  academyProfileId: string,
  creationRequestId: string,
): Promise<string | null> {
  return resolveOrCreateInvoicePerson({
    playerName,
    playerEmail,
    scope: 'academy',
    academyProfileId,
    creationRequestId,
  });
}

export type CreateDraftInvoiceForPersonArgs = {
  scope: 'academy' | 'trainer';
  ownerId: string;
  /** Canonical Player the invoice is for; null = deliberately unlinked (one-time recipient). */
  personId: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  playerName: string;
  playerBusinessName: string | null;
  playerAddress: string | null;
  playerBtwNumber: string | null;
  lineItems: Json;
  subtotal: number;
  vatRate: number;
  vatAmount: number;
  vatBreakdown: Json | null;
  total: number;
  pricesIncludeVat: boolean;
  notes: string | null;
};

/**
 * The invoice INSERT, moved server-side. One call, one transaction: `invoice_create_for_person`
 * authorizes the caller against the same predicates as the old RLS insert, derives the temporary
 * legacy columns from the person internally, writes the row and answers with canonical ids.
 *
 * Throws the raw PostgREST error on failure so the callers' allocate-retry loop can keep keying on
 * `isInvoiceNumberCollision` (the unique-constraint name travels in the error message).
 */
export async function createDraftInvoiceForPerson(
  args: CreateDraftInvoiceForPersonArgs,
): Promise<{ invoiceId: string }> {
  const { data, error } = await supabase.rpc('invoice_create_for_person', {
    _owner_type: args.scope,
    _owner_id: args.ownerId,
    _person_id: args.personId,
    _invoice_number: args.invoiceNumber,
    _invoice_date: args.invoiceDate,
    _due_date: args.dueDate,
    _player_name: args.playerName,
    _player_business_name: args.playerBusinessName,
    _player_address: args.playerAddress,
    _player_btw_number: args.playerBtwNumber,
    _line_items: args.lineItems,
    _subtotal: args.subtotal,
    _vat_rate: args.vatRate,
    _vat_amount: args.vatAmount,
    _vat_breakdown: args.vatBreakdown,
    _total: args.total,
    _prices_include_vat: args.pricesIncludeVat,
    _notes: args.notes,
  });
  if (error) throw error;
  const result = data as { invoice_id: string } | null;
  if (!result?.invoice_id) throw new Error('invoice_create_no_result');
  return { invoiceId: result.invoice_id };
}
