// Cycle pricing write, extracted from lib/cycles.ts (god-file split). updateCyclePricing pushes
// the price to the cycle row + all linked slots via the atomic update_cycle_pricing RPC; the caller
// still runs syncInvoicesAfterPriceChange afterward. cycles.ts re-exports it via `export *`.
import { supabase } from '@/lib/supabaseClient';
import type { Json } from '@/integrations/supabase/types';
import type { ExtraCost } from './cycleTypes';

/**
 * Update pricing on cycle record + bulk-update all linked availability_slots.
 */
export async function updateCyclePricing(
  cycleId: string,
  pricing: {
    price_per_session: number | null;
    extra_costs: ExtraCost[];
    split_payment: boolean;
    prices_include_vat: boolean;
  }
) {
  // Atomic: the RPC updates the cycle row AND all linked slots in ONE
  // transaction (id-ordered slot lock — shares the canonical cycle→slots lock
  // order with applySlotEditToCycle/applySlotDeleteToCycle), so billing (which
  // reads the slot columns) can never drift from the cycle after a partial
  // client-side write. (Was two separate updates.) NOTE: this only pushes the
  // price; the caller still runs syncInvoicesAfterPriceChange afterward to
  // rebuild affected invoice line-item amounts + PDFs (the pricing engine + PDF
  // regen can't run in Postgres).
  const { error } = await supabase.rpc('update_cycle_pricing', {
    _cycle_id: cycleId,
    _price_per_session: pricing.price_per_session,
    _extra_costs: pricing.extra_costs as unknown as Json,
    _split_payment: pricing.split_payment,
    _prices_include_vat: pricing.prices_include_vat,
  });

  if (error) throw error;
}
