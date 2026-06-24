import { describe, it, expect } from 'vitest';
import { mapInvoiceSortKeyToRpc } from './useInvoiceListSort';

/**
 * Pins the header-column → RPC sort-param mapping that both invoice list pages previously inlined
 * (trainer as a switch, academy as a ternary chain). A drift here changes server-side ordering.
 */
describe('mapInvoiceSortKeyToRpc', () => {
  it('maps each header sort key to its RPC column', () => {
    expect(mapInvoiceSortKeyToRpc('player_name')).toBe('player_name');
    expect(mapInvoiceSortKeyToRpc('total')).toBe('total');
    expect(mapInvoiceSortKeyToRpc('due_date')).toBe('due_date');
    expect(mapInvoiceSortKeyToRpc('paid_at')).toBe('paid_at');
  });

  it('maps the synthetic _computedStatus key to the RPC status sort', () => {
    expect(mapInvoiceSortKeyToRpc('_computedStatus')).toBe('status');
  });

  it('falls back to created_at when no column is chosen', () => {
    expect(mapInvoiceSortKeyToRpc(null)).toBe('created_at');
  });
});
