import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvoiceLineItemsEditor, type InvoiceLineItemsLabels } from './InvoiceLineItemsEditor';
import type { InvoiceFormLineItem } from '@/lib/invoiceFormTotals';

const labels: InvoiceLineItemsLabels = {
  title: 'Line items',
  description: 'Description',
  descriptionPlaceholder: 'Describe…',
  quantity: 'Qty',
  price: 'Price',
  vatPercent: 'VAT %',
  total: 'Total',
  addRow: 'Add row',
  removeRow: 'Remove row',
  formatMobileTotal: (amount) => `Total: ${amount}`,
};

const twoItems: InvoiceFormLineItem[] = [
  { description: 'Coaching', quantity: 2, unit_price: 25, amount: 50, vat_rate: 21 },
  { description: 'Court', quantity: 1, unit_price: 10, amount: 10, vat_rate: 9 },
];

function renderEditor(props: Partial<React.ComponentProps<typeof InvoiceLineItemsEditor>> = {}) {
  const onChange = vi.fn();
  render(
    <InvoiceLineItemsEditor
      lineItems={twoItems}
      onChange={onChange}
      newRowVatRate={21}
      labels={labels}
      {...props}
    />,
  );
  return { onChange };
}

describe('InvoiceLineItemsEditor', () => {
  it('renders a row for each line item (desktop + mobile)', () => {
    renderEditor();
    // Each item renders in both the desktop grid and the mobile card → 2 inputs per value.
    expect(screen.getAllByDisplayValue('Coaching')).toHaveLength(2);
    expect(screen.getAllByDisplayValue('Court')).toHaveLength(2);
  });

  it('adds a blank row using newRowVatRate when the add button is clicked', () => {
    const { onChange } = renderEditor({ newRowVatRate: 9 });
    fireEvent.click(screen.getByText('Add row'));
    expect(onChange).toHaveBeenCalledWith([
      ...twoItems,
      { description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: 9 },
    ]);
  });

  it('removes the clicked row', () => {
    const { onChange } = renderEditor();
    // 2 items × (desktop + mobile) = 4 remove buttons; the first targets row 0.
    fireEvent.click(screen.getAllByLabelText('Remove row')[0]);
    expect(onChange).toHaveBeenCalledWith([twoItems[1]]);
  });

  it('disables removal when only one row remains', () => {
    renderEditor({ lineItems: [twoItems[0]] });
    for (const btn of screen.getAllByLabelText('Remove row')) {
      expect(btn).toBeDisabled();
    }
  });

  it('appends a preset row via the injected preset picker', () => {
    const { onChange } = renderEditor({
      presetPicker: (addPreset) => (
        <button type="button" onClick={() => addPreset({ description: 'Shuttle', price: 15, vat_rate: 21 })}>
          preset
        </button>
      ),
    });
    fireEvent.click(screen.getByText('preset'));
    expect(onChange).toHaveBeenCalledWith([
      ...twoItems,
      { description: 'Shuttle', quantity: 1, unit_price: 15, amount: 15, vat_rate: 21 },
    ]);
  });

  it('emits an updated description with recomputed amount on edit', () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getAllByDisplayValue('Coaching')[0], { target: { value: 'Private lesson' } });
    expect(onChange).toHaveBeenCalledWith([
      { description: 'Private lesson', quantity: 2, unit_price: 25, amount: 50, vat_rate: 21 },
      twoItems[1],
    ]);
  });

  it('renders the mobile per-row total via the injected formatter', () => {
    renderEditor();
    expect(screen.getAllByText(/^Total: /).length).toBeGreaterThan(0);
  });
});
