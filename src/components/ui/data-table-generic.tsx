import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { To } from 'react-router-dom';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { DataTableCard, compactDataTableClass } from '@/components/ui/data-table';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { SortDirection } from '@/hooks/useTableSort';

export type Align = 'left' | 'right' | 'center';

const alignClass: Record<Align, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

/**
 * One column of a {@link DataTable}. Folds the three legacy per-table sources of truth — the
 * visibility descriptor, the header JSX and the body `switch(key)` — into a single object.
 */
export interface ColumnDef<T> {
  /** Stable id; also the key used by an (external) column-visibility menu. */
  key: string;
  header: ReactNode;
  renderCell: (row: T) => ReactNode;
  /** Present => the header is sortable; this key is emitted to `onSort` (caller maps to a local hook OR an RPC param). */
  sortKey?: string;
  align?: Align;
  /** `<td>` className (truncation, width, responsive `hidden md:table-cell`, …). */
  className?: string;
  /** `<th>` className. */
  headClassName?: string;
  /** Metadata for an external column-visibility menu — the engine itself reads `visibleKeys`. */
  isDefault?: boolean;
  /**
   * When set, THIS column's cell content is wrapped in a react-router `<Link to={linkTo(row)}>` — giving
   * native Cmd/Ctrl/middle/right-click "open in new tab" on that cell. Return `null` for a non-navigable
   * row. Mark exactly the column you want as the link target (usually the name/number). Do NOT also render
   * your own `<a>`/`<Link>`/`<button>` inside this column's `renderCell` when `linkTo` is set — that would
   * nest interactive elements / anchors.
   */
  linkTo?: (row: T) => To | null;
}

export interface DataTableSelection<T extends { id: string }> {
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (visibleRows: T[]) => void;
  /** Whether all visible rows are selected (header checkbox state); defaults to an every()-check. */
  isAllSelected?: (visibleRows: T[]) => boolean;
  rowAriaLabel?: (row: T) => string;
  selectAllAriaLabel?: string;
}

export interface DataTableProps<T extends { id: string }> {
  columns: ColumnDef<T>[];
  rows: T[];
  /** Controlled column visibility; `undefined` => every column shown. */
  visibleKeys?: string[];
  /**
   * CONTROLLED sort only — the engine never reorders rows. Callers pass pre-sorted rows (client-sorted
   * via `useTableSort`, OR server-sorted via an RPC) and the current `sortKey`/`sortDirection`.
   */
  sortKey?: string | null;
  sortDirection?: SortDirection;
  onSort?: (key: string) => void;
  /**
   * Whole-row click convenience for the row's dead area — auto-ignored on modifier clicks and text
   * selection, so a modifier/middle click falls through to a column's `linkTo` `<Link>` (open-in-new-tab)
   * instead of being hijacked. Per-cell "open in new tab" lives on {@link ColumnDef.linkTo}, not here.
   */
  onRowClick?: (row: T) => void;
  selection?: DataTableSelection<T>;
  renderActions?: (row: T) => ReactNode;
  /** Header label for the trailing actions column (default: a visually-hidden "Actions"). */
  actionsHeader?: ReactNode;
  /** Rendered (as a single full-width cell) when there are no rows. */
  empty?: ReactNode;
  /** Mobile list rendered below the desktop table (caller-built; the desktop table is md+ only). */
  mobile?: ReactNode;
  /** Compact operational density (h-10 rows). */
  compact?: boolean;
  cardTestId?: string;
  cardClassName?: string;
  /** Forwarded to DataTableCard — set false for dashboard/compact tables that show on mobile too. */
  desktopOnly?: boolean;
  /** Row identity (default `row.id`). */
  getRowKey?: (row: T) => string;
}

/**
 * Shared, configurable data table. Composes the existing primitives (DataTableCard frame + Table +
 * the a11y-upgraded SortableTableHead) around a column-def model. Presentation + interaction only —
 * sorting, filtering, pagination and data-fetching stay with the caller (sort is controlled; see above).
 *
 * Right-click / middle-click / Cmd-click "open in new tab" works via a react-router `<Link>` on the
 * cell of whichever column opts in with {@link ColumnDef.linkTo} — never a full-row stretched `<a>` (a
 * `<tr>` cannot legally contain an `<a>`, and every navigable row already has a checkbox / actions cell an
 * overlay would fight). Linking is explicit per-column (not implicit-on-column-0) so a consumer whose cell
 * already renders its own `<Link>` simply doesn't set `linkTo` and avoids nested anchors. The whole-row
 * `onClick` convenience is gated so modifier/middle clicks fall through to the Link and a text-drag never
 * navigates.
 */
export function DataTable<T extends { id: string }>({
  columns,
  rows,
  visibleKeys,
  sortKey,
  sortDirection,
  onSort,
  onRowClick,
  selection,
  renderActions,
  actionsHeader,
  empty,
  mobile,
  compact,
  cardTestId,
  cardClassName,
  desktopOnly,
  getRowKey = (row) => row.id,
}: DataTableProps<T>) {
  const visibleColumns = visibleKeys
    ? columns.filter((c) => visibleKeys.includes(c.key))
    : columns;
  const colCount = visibleColumns.length + (selection ? 1 : 0) + (renderActions ? 1 : 0);

  const isAllSelected =
    selection &&
    (selection.isAllSelected
      ? selection.isAllSelected(rows)
      : rows.length > 0 && rows.every((r) => selection.selectedIds.has(getRowKey(r))));

  return (
    <DataTableCard
      mobile={mobile}
      testId={cardTestId}
      className={cardClassName}
      desktopOnly={desktopOnly}
    >
      <Table className={cn(compact && compactDataTableClass)}>
        <TableHeader>
          <TableRow>
            {selection && (
              <TableHead className="w-10">
                <Checkbox
                  checked={!!isAllSelected}
                  onCheckedChange={() => selection.onToggleAll(rows)}
                  aria-label={selection.selectAllAriaLabel}
                />
              </TableHead>
            )}
            {visibleColumns.map((col) =>
              col.sortKey && onSort ? (
                <SortableTableHead
                  key={col.key}
                  sortKey={col.sortKey}
                  currentSortKey={sortKey ?? null}
                  currentDirection={sortDirection ?? null}
                  onSort={onSort}
                  className={cn(col.align && alignClass[col.align], col.headClassName)}
                >
                  {col.header}
                </SortableTableHead>
              ) : (
                <TableHead
                  key={col.key}
                  className={cn(col.align && alignClass[col.align], col.headClassName)}
                >
                  {col.header}
                </TableHead>
              ),
            )}
            {renderActions && (
              <TableHead className="text-right">
                {actionsHeader ?? <span className="sr-only">Actions</span>}
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const rowKey = getRowKey(row);
              const selected = selection?.selectedIds.has(rowKey) ?? false;
              const handleRowClick = onRowClick
                ? (e: React.MouseEvent) => {
                    // Let modifier / non-primary-button clicks fall through to a column's linkTo <Link>
                    // (open-in-new-tab etc.), and never navigate at the end of a text-drag select.
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
                    onRowClick(row);
                  }
                : undefined;

              return (
                <TableRow
                  key={rowKey}
                  onClick={handleRowClick}
                  className={cn(onRowClick && 'cursor-pointer')}
                  data-state={selected ? 'selected' : undefined}
                >
                  {selection && (
                    <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected}
                        onCheckedChange={() => selection.onToggle(rowKey)}
                        aria-label={selection.rowAriaLabel?.(row)}
                      />
                    </TableCell>
                  )}
                  {visibleColumns.map((col) => {
                    const content = col.renderCell(row);
                    const href = col.linkTo ? col.linkTo(row) : null;
                    const cellInner =
                      href != null ? (
                        <Link
                          to={href}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {content}
                        </Link>
                      ) : (
                        content
                      );
                    return (
                      <TableCell
                        key={col.key}
                        className={cn(col.align && alignClass[col.align], col.className)}
                      >
                        {cellInner}
                      </TableCell>
                    );
                  })}
                  {renderActions && (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1">{renderActions(row)}</div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </DataTableCard>
  );
}
