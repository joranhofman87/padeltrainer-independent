import type { ReactNode } from 'react';
import type { Locale } from 'date-fns';
import { format } from 'date-fns';
import { Mail } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { dataTableCardContentClass } from '@/components/ui/app-page';
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
  /** Role-specific per-row actions cell (ShareDropdown / forward button etc.). */
  renderActions: (row: T) => ReactNode;
}

/**
 * The desktop invoice LIST table (9 columns) shared by the trainer + academy pages. Columns 1–8
 * (selection, number, player, delivery, date, paid/due, amount, status) are identical across roles
 * — including the now-shared `InvoiceListStatusBadge`; the role-specific actions column is injected
 * via `renderActions`. Each page keeps its own (divergent) mobile card list. Behaviour-preserving.
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
  renderActions,
}: InvoiceListTableProps<T>) {
  const allSelected = rows.length > 0 && rows.every((i) => selectedIds.has(i.id));
  const fmt = (value: string) => format(new Date(value), 'dd MMM yyyy', { locale: dateFnsLocale });

  return (
    <div className="hidden md:block">
      <Card>
        <CardContent className={dataTableCardContentClass}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allSelected} onCheckedChange={() => onToggleSelectAll(rows)} aria-label={labels.selectAll} />
                </TableHead>
                <TableHead>{labels.number}</TableHead>
                <TableHead>{labels.player}</TableHead>
                <TableHead>{labels.delivery}</TableHead>
                <TableHead>{labels.date}</TableHead>
                {activeTab === 'paid' ? (
                  <SortableTableHead sortKey="paid_at" currentSortKey={sortKey} currentDirection={sortDirection} onSort={onSort}>
                    {labels.paymentDate}
                  </SortableTableHead>
                ) : (
                  <SortableTableHead sortKey="due_date" currentSortKey={sortKey} currentDirection={sortDirection} onSort={onSort}>
                    {labels.dueDate}
                  </SortableTableHead>
                )}
                <SortableTableHead sortKey="total" currentSortKey={sortKey} currentDirection={sortDirection} onSort={onSort} className="text-right">
                  {labels.amount}
                </SortableTableHead>
                <SortableTableHead sortKey="_computedStatus" currentSortKey={sortKey} currentDirection={sortDirection} onSort={onSort}>
                  {labels.status}
                </SortableTableHead>
                <TableHead className="text-right">{labels.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((inv) => (
                <TableRow key={inv.id} className="cursor-pointer" onClick={() => onRowClick(inv)}>
                  <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(inv.id)}
                      onCheckedChange={() => onToggleSelect(inv.id)}
                      aria-label={labels.selectRow(inv.invoice_number)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                  <TableCell>{inv.player_name}</TableCell>
                  <TableCell>
                    <InvoiceDeliveryChip deliveryStatus={inv.delivery_status} hasEmail={inv.linked_email != null} />
                  </TableCell>
                  <TableCell>{fmt(inv.invoice_date)}</TableCell>
                  <TableCell>{activeTab === 'paid' ? (inv.paid_at ? fmt(inv.paid_at) : '-') : fmt(inv.due_date)}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(inv.total)}</TableCell>
                  <TableCell>
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
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">{renderActions(inv)}</div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
