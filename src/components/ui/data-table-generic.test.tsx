import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { DataTable, type ColumnDef } from './data-table-generic';

type Row = { id: string; name: string; amount: number };

const rows: Row[] = [
  // Deliberately NOT in amount order, to prove the engine never sorts internally.
  { id: 'r1', name: 'Alice', amount: 30 },
  { id: 'r2', name: 'Bob', amount: 10 },
];

const columns: ColumnDef<Row>[] = [
  { key: 'name', header: 'Name', renderCell: (r) => r.name },
  { key: 'amount', header: 'Amount', sortKey: 'amount', align: 'right', renderCell: (r) => String(r.amount) },
];

// `name` column opts into a per-cell <Link> (the open-in-new-tab affordance).
const linkedColumns: ColumnDef<Row>[] = [
  { key: 'name', header: 'Name', renderCell: (r) => r.name, linkTo: (r) => `/x/${r.id}` },
  { key: 'amount', header: 'Amount', sortKey: 'amount', align: 'right', renderCell: (r) => String(r.amount) },
];

const renderDT = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('DataTable', () => {
  it('renders only the visible columns', () => {
    renderDT(<DataTable columns={columns} rows={rows} visibleKeys={['amount']} />);
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('does NOT reorder rows — sort is controlled (renders rows as given)', () => {
    renderDT(<DataTable columns={columns} rows={rows} sortKey="amount" sortDirection="asc" onSort={vi.fn()} />);
    const bodyRows = screen.getAllByRole('row').slice(1); // drop header
    expect(within(bodyRows[0]).getByText('Alice')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByText('Bob')).toBeInTheDocument();
  });

  // --- Per-column link (open-in-new-tab) ---
  it('wraps a linkTo column cell in an <a href>; other cells are not anchors', () => {
    renderDT(<DataTable columns={linkedColumns} rows={rows} />);
    expect(screen.getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/x/r1');
    expect(screen.getByText('30').closest('a')).toBeNull();
  });

  it('linkTo returning null => that row is non-navigable (no anchor)', () => {
    const cols: ColumnDef<Row>[] = [
      { key: 'name', header: 'Name', renderCell: (r) => r.name, linkTo: (r) => (r.id === 'r1' ? null : `/x/${r.id}`) },
      { key: 'amount', header: 'Amount', renderCell: (r) => String(r.amount) },
    ];
    renderDT(<DataTable columns={cols} rows={rows} />);
    expect(screen.queryByRole('link', { name: 'Alice' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/x/r2');
  });

  it('the link follows its COLUMN, not index 0 — hiding the linked column removes the link', () => {
    // `name` (the linkTo column) is hidden; `amount` becomes the first visible column but must NOT link.
    renderDT(<DataTable columns={linkedColumns} rows={rows} visibleKeys={['amount']} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('30').closest('a')).toBeNull();
  });

  // --- Whole-row click gating ---
  it('plain left-click on a non-link cell calls onRowClick', () => {
    const onRowClick = vi.fn();
    renderDT(<DataTable columns={columns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('30'));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });

  it('modifier clicks (Cmd/Ctrl/Shift) do NOT call onRowClick (fall through to the Link)', () => {
    const onRowClick = vi.fn();
    renderDT(<DataTable columns={columns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('30'), { metaKey: true });
    fireEvent.click(screen.getByText('30'), { ctrlKey: true });
    fireEvent.click(screen.getByText('30'), { shiftKey: true });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('a non-primary-button (middle) click does NOT call onRowClick', () => {
    const onRowClick = vi.fn();
    renderDT(<DataTable columns={columns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('30'), { button: 1 });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('does NOT navigate at the end of a text-drag selection', () => {
    const onRowClick = vi.fn();
    const sel = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'dragged text' } as Selection);
    renderDT(<DataTable columns={columns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText('30'));
    expect(onRowClick).not.toHaveBeenCalled();
    sel.mockRestore();
  });

  it('clicking a linkTo cell does NOT also fire the row onClick', () => {
    const onRowClick = vi.fn();
    renderDT(<DataTable columns={linkedColumns} rows={rows} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByRole('link', { name: 'Alice' }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  // --- Selection ---
  it('checkbox cell stops propagation: toggling a row does not trigger onRowClick', () => {
    const onRowClick = vi.fn();
    const onToggle = vi.fn();
    renderDT(
      <DataTable
        columns={columns}
        rows={rows}
        onRowClick={onRowClick}
        selection={{
          selectedIds: new Set(),
          onToggle,
          onToggleAll: vi.fn(),
          rowAriaLabel: (r) => `Select ${r.name}`,
          selectAllAriaLabel: 'Select all',
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select Alice'));
    expect(onToggle).toHaveBeenCalledWith('r1');
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('select-all reflects state + calls onToggleAll', () => {
    const onToggleAll = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <DataTable
          columns={columns}
          rows={rows}
          selection={{ selectedIds: new Set(), onToggle: vi.fn(), onToggleAll, selectAllAriaLabel: 'Select all' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Select all')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(onToggleAll).toHaveBeenCalled();

    rerender(
      <MemoryRouter>
        <DataTable
          columns={columns}
          rows={rows}
          selection={{ selectedIds: new Set(['r1', 'r2']), onToggle: vi.fn(), onToggleAll, selectAllAriaLabel: 'Select all' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Select all')).toBeChecked();
  });

  // --- Sorting + a11y header ---
  it('sortable header is a focusable button, emits onSort(key), and the <th> exposes aria-sort', () => {
    const onSort = vi.fn();
    renderDT(
      <DataTable columns={columns} rows={rows} sortKey="amount" sortDirection="asc" onSort={onSort} />,
    );
    const sortBtn = screen.getByRole('button', { name: 'Amount' });
    // The control is a real <button> => focusable + keyboard-operable (Enter/Space), not a click-only <th>.
    expect(sortBtn.tagName).toBe('BUTTON');
    fireEvent.click(sortBtn);
    expect(onSort).toHaveBeenCalledWith('amount');
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toHaveAttribute('aria-sort', 'ascending');
    // A non-sortable column has NO button.
    expect(screen.queryByRole('button', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('inactive sortable columns expose aria-sort="none"', () => {
    renderDT(<DataTable columns={columns} rows={rows} sortKey={null} sortDirection={null} onSort={vi.fn()} />);
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toHaveAttribute('aria-sort', 'none');
  });

  // --- Actions ---
  it('actions cell stops propagation', () => {
    const onRowClick = vi.fn();
    renderDT(
      <DataTable
        columns={columns}
        rows={rows}
        onRowClick={onRowClick}
        renderActions={(r) => <button>act-{r.id}</button>}
      />,
    );
    fireEvent.click(screen.getByText('act-r1'));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  // --- Empty ---
  it('renders the empty slot when there are no rows', () => {
    renderDT(<DataTable columns={columns} rows={[]} empty={<span>No data yet</span>} />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('empty-row colSpan counts the selection + actions columns', () => {
    renderDT(
      <DataTable
        columns={columns}
        rows={[]}
        empty={<span>No data yet</span>}
        selection={{ selectedIds: new Set(), onToggle: vi.fn(), onToggleAll: vi.fn(), selectAllAriaLabel: 'Select all' }}
        renderActions={() => <button>act</button>}
      />,
    );
    // 2 columns + selection + actions = 4
    expect(screen.getByText('No data yet').closest('td')).toHaveAttribute('colspan', '4');
  });
});
