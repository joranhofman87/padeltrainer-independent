/**
 * Error-body extraction for the guest cart checkout. The cart edge function's refusals
 * carry structure beyond a bare code — `{ error, slotIds }` names exactly which selected
 * sessions went stale (create-guest-cart-payment contract) so the UI can prune them and
 * let the guest retry. `extractFnErrorCode` in GuestBookingDialog only surfaces the code;
 * this returns the parsed body.
 */
export type CartFnErrorBody = {
  error?: string;
  /** The offending slot ids for slot_unavailable / slot_full / mixed_recipient / …. */
  slotIds?: string[];
  /** already_booked carries the existing confirmation token. */
  token?: string;
};

/** Read the JSON body from a supabase functions.invoke failure (non-2xx). */
export async function extractCartFnError(error: unknown): Promise<CartFnErrorBody | null> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as CartFnErrorBody;
      return body && typeof body === 'object' ? body : null;
    } catch {
      /* fall through */
    }
  }
  return null;
}
