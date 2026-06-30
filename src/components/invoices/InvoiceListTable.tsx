import type { ReactNode } from 'react';
import type { Locale } from 'date-fns';
import { format } from 'date-fns';
import { Mail } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { InvoiceDeliveryChip } from '@/components/email/InvoiceDeliveryChip';
import { formatCurrency } from '@/lib/format';
import type { SortDirection } from '@/hooks/useTableSort';
import { InvoiceListStatusBadge } from './InvoiceListStatusBadge';

/** Fields the shared list table reads from a get_*_invoices row. Both TrainerInvoiceRow and
 *  AcademyInvoiceRow satisfy this. */
export interface InvoiceListRow {
  id: string;
  invoice_number: string;
  player_name: string;
  delivery_status: string | null;
  linked_email: string | null;
  invoice_date: string;
  paid_at: string | null;
  due_date: string;
  total: number;
  forwarded_at: string | null;
  computed_status: string;
}

export interface InvoiceListTableLabels {
  selectAll: string;
  number: string;
  player: string;
  delivery: string;
  date: string;
  paymentDate: string;
  dueDate: string;
  amount: string;
  status: string;
  actions: string;
  selectRow: (invoiceNumber: string) => string;
  forwardedOn: (formattedDateTime: string) => string;
}

interface InvoiceListTableProps<T extends InvoiceListRow> {
  rows: T[];
  /** 'paid' swaps the Date-column to the paid-date and shows paid_at sorting. */
  activeTab: string;
  dateFnsLocale: Locale;
  labels: InvoiceListTableLabels;
  sortKey: string | null;
  sortDirection: SortDirection;
  onSort: (key: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: (rows: T[]) => void;
  onRowClick: (row: T) => void;
  /** Per-row destination for the number-cell <Link> — the open-in-new-tab target. Role-specific
   *  (`/app/{trainer|academy}/invoices/:id/edit`). */
  rowHref: (row: T) => string;
  /** Role-specific per-row actions cell (ShareDropdown / forward button etc.). */
  renderActions: (row: T) => ReactNode;
}

/**
 * The desktop invoice LIST table (9 columns) shared by the trainer + academy pages. Columns 1–8
 * (selection, number, player, delivery, date, paid/due, amount, status) are identical across roles
 * — including the now-shared `InvoiceListStatusBadge`; the role-specific actions column is injected
 * via `renderActions`. Each page keeps its own (divergent) mobile card list, so the whole desktop
 * table stays hidden on mobile (`hidden md:block`) and the engine's own breakpoint is disabled.
 *
 * Built on the shared {@link DataTable} engine: the number cell is the per-row `<Link>` (so right /
 * middle / Cmd-click opens the invoice in a new tab), while the whole-row `onClick` stays as the
 * dead-area convenience (gated by the engine so modifier clicks fall through to the link).
 */
export function InvoiceListTable<T extends InvoiceListRow>({
  rows,
  activeTab,
  dateFnsLocale,
  labels,
  sortKey,
  sortDirection,
  onSort,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onRowClick,
  rowHref,
  renderActions,
}: InvoiceListTableProps<T>) {
  const fmt = (value: string) => format(new Date(value), 'dd MMM yyyy', { locale: dateFnsLocale });

  const columns: ColumnDef<T>[] = [
    {
      key: 'number',
      header: labels.number,
      className: 'font-mono text-sm',
      renderCell: (inv) => inv.invoice_number,
      linkTo: (inv) => rowHref(inv),
    },
    { key: 'player', header: labels.player, renderCell: (inv) => inv.player_name },
    {
      key: 'delivery',
      header: labels.delivery,
      renderCell: (inv) => (
        <InvoiceDeliveryChip deliveryStatus={inv.delivery_status} hasEmail={inv.linked_email != null} />
      ),
    },
    { key: 'date', header: labels.date, renderCell: (inv) => fmt(inv.invoice_date) },
    activeTab === 'paid'
      ? {
          key: 'paid_at',
          header: labels.paymentDate,
          sortKey: 'paid_at',
          renderCell: (inv) => (inv.paid_at ? fmt(inv.paid_at) : '-'),
        }
      : {
          key: 'due_date',
          header: labels.dueDate,
          sortKey: 'due_date',
          renderCell: (inv) => fmt(inv.due_date),
        },
    {
      key: 'total',
      header: labels.amount,
      sortKey: 'total',
      align: 'right',
      className: 'font-medium',
      renderCell: (inv) => formatCurrency(inv.total),
    },
    {
      key: 'status',
      header: labels.status,
      sortKey: '_computedStatus',
      renderCell: (inv) => (
        <div className="flex items-center gap-1.5">
          <InvoiceListStatusBadge invoiceId={inv.id} status={inv.computed_status} />
          {inv.forwarded_at && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>
                {labels.forwardedOn(format(new Date(inv.forwarded_at), 'dd MMM yyyy HH:mm', { locale: dateFnsLocale }))}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="hidden md:block">
      <DataTable<T>
        columns={columns}
        rows={rows}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={onSort}
        onRowClick={onRowClick}
        selection={{
          selectedIds,
          onToggle: onToggleSelect,
          onToggleAll: onToggleSelectAll,
          rowAriaLabel: (inv) => labels.selectRow(inv.invoice_number),
          selectAllAriaLabel: labels.selectAll,
        }}
        renderActions={renderActions}
        actionsHeader={labels.actions}
        // The whole desktop table is already wrapped in `hidden md:block` (each page renders its own
        // mobile card list), so the engine must NOT also hide its inner scroll region — that would
        // double-hide and leave an empty card shell on mobile.
        desktopOnly={false}
      />
    </div>
  );
}
