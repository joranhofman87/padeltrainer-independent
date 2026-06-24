import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { enUS } from 'date-fns/locale';
import { InvoiceListTable, type InvoiceListRow, type InvoiceListTableLabels } from './InvoiceListTable';

vi.mock('./InvoiceListStatusBadge', () => ({
  InvoiceListStatusBadge: ({ status }: { status: string }) => <span data-testid="status">{status}</span>,
}));
vi.mock('@/components/email/InvoiceDeliveryChip', () => ({
  InvoiceDeliveryChip: () => <span data-testid="delivery" />,
}));

type Row = InvoiceListRow & { status: string };
const rows: Row[] = [
  { id: 'a', invoice_number: 'INV-1', player_name: 'Alice', delivery_status: 'delivered', linked_email: 'a@x.nl', invoice_date: '2026-01-10', paid_at: null, due_date: '2026-02-10', total: 100, forwarded_at: null, computed_status: 'sent', status: 'sent' },
  { id: 'b', invoice_number: 'INV-2', player_name: 'Bob', delivery_status: null, linked_email: null, invoice_date: '2026-01-11', paid_at: '2026-01-20', due_date: '2026-02-11', total: 50, forwarded_at: null, computed_status: 'paid', status: 'paid' },
];

const labels: InvoiceListTableLabels = {
  selectAll: 'Select all', number: 'Number', player: 'Player', delivery: 'Delivery', date: 'Date',
  paymentDate: 'Payment date', dueDate: 'Due', amount: 'Amount', status: 'Status', actions: 'Actions',
  selectRow: (n) => `Select ${n}`, forwardedOn: (d) => `Forwarded on ${d}`,
};

function renderTable(overrides: Partial<React.ComponentProps<typeof InvoiceListTable<Row>>> = {}) {
  const props = {
    rows, activeTab: 'unpaid', dateFnsLocale: enUS, labels,
    sortKey: null, sortDirection: null,
    onSort: vi.fn(), selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(), onToggleSelectAll: vi.fn(), onRowClick: vi.fn(),
    renderActions: (inv: Row) => <button>act-{inv.id}</button>,
    ...overrides,
  };
  render(<InvoiceListTable<Row> {...props} />);
  return props;
}

describe('InvoiceListTable', () => {
  it('renders a row per invoice with money + status', () => {
    renderTable();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('INV-1')).toBeInTheDocument();
    expect(screen.getAllByTestId('status').map((n) => n.textContent)).toEqual(['sent', 'paid']);
  });

  it('renders the role-specific actions slot per row', () => {
    renderTable();
    expect(screen.getByText('act-a')).toBeInTheDocument();
    expect(screen.getByText('act-b')).toBeInTheDocument();
  });

  it('navigates on row click but not when the checkbox is clicked', () => {
    const { onRowClick, onToggleSelect } = renderTable();
    fireEvent.click(screen.getByText('Alice'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Select INV-1'));
    expect(onToggleSelect).toHaveBeenCalledWith('a');
    expect(onRowClick).toHaveBeenCalledTimes(1); // checkbox stops propagation
  });

  it('toggles all visible rows from the header checkbox', () => {
    const { onToggleSelectAll } = renderTable();
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(onToggleSelectAll).toHaveBeenCalledWith(rows);
  });

  it('fires onSort with the column key when a sortable header is clicked', () => {
    const { onSort } = renderTable();
    fireEvent.click(screen.getByText('Amount'));
    expect(onSort).toHaveBeenCalledWith('total');
  });

  it('shows the due-date column on the unpaid tab and the payment-date column on the paid tab', () => {
    const { unmount } = render(
      <InvoiceListTable<Row>
        rows={rows} activeTab="unpaid" dateFnsLocale={enUS} labels={labels}
        sortKey={null} sortDirection={null} onSort={vi.fn()} selectedIds={new Set()}
        onToggleSelect={vi.fn()} onToggleSelectAll={vi.fn()} onRowClick={vi.fn()}
        renderActions={() => null}
      />,
    );
    expect(screen.getByText('Due')).toBeInTheDocument();
    expect(screen.queryByText('Payment date')).not.toBeInTheDocument();
    unmount();
    render(
      <InvoiceListTable<Row>
        rows={rows} activeTab="paid" dateFnsLocale={enUS} labels={labels}
        sortKey={null} sortDirection={null} onSort={vi.fn()} selectedIds={new Set()}
        onToggleSelect={vi.fn()} onToggleSelectAll={vi.fn()} onRowClick={vi.fn()}
        renderActions={() => null}
      />,
    );
    expect(screen.getByText('Payment date')).toBeInTheDocument();
  });

  it('marks a selected row checkbox as checked', () => {
    renderTable({ selectedIds: new Set(['a']) });
    const aliceRow = screen.getByText('Alice').closest('tr')!;
    expect(within(aliceRow).getByLabelText('Select INV-1')).toBeChecked();
  });
});
