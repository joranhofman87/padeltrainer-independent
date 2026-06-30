import { TableHead } from "@/components/ui/table";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDirection } from "@/hooks/useTableSort";

interface SortableTableHeadProps {
  children: React.ReactNode;
  sortKey: string;
  currentSortKey: string | null;
  currentDirection: SortDirection;
  onSort: (key: string) => void;
  className?: string;
}

/**
 * Sortable column header. The clickable control is a real inner <button> (focusable, keyboard-operable
 * via native Enter/Space) and the <th> carries `aria-sort`, so the header is reachable and announced by
 * screen readers — not mouse-only. The button inherits the cell's text styling (Tailwind preflight sets
 * `button { font: inherit }`), so the visuals match the previous click-anywhere <th>.
 */
export function SortableTableHead({
  children,
  sortKey,
  currentSortKey,
  currentDirection,
  onSort,
  className,
}: SortableTableHeadProps) {
  const isActive = currentSortKey === sortKey;
  const ariaSort: React.AriaAttributes["aria-sort"] = isActive
    ? currentDirection === "asc"
      ? "ascending"
      : currentDirection === "desc"
        ? "descending"
        : "none"
    : "none";

  return (
    <TableHead aria-sort={ariaSort} className={cn("select-none", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted/50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{children}</span>
        {isActive && currentDirection === "asc" ? (
          <ArrowUp className="h-3.5 w-3.5 text-foreground" />
        ) : isActive && currentDirection === "desc" ? (
          <ArrowDown className="h-3.5 w-3.5 text-foreground" />
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </button>
    </TableHead>
  );
}
