import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceStatTiles } from './InvoiceStatTiles';

describe('InvoiceStatTiles', () => {
  it('renders a tile per entry with its label and value', () => {
    render(
      <InvoiceStatTiles
        tiles={[
          { label: 'Unpaid', value: '€ 1.234,00' },
          { label: 'Open invoices', value: 7 },
          { label: 'Paid', value: 42 },
        ]}
      />,
    );
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
    expect(screen.getByText('€ 1.234,00')).toBeInTheDocument();
    expect(screen.getByText('Open invoices')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});
