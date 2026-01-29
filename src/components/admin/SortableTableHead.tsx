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

export function SortableTableHead({
  children,
  sortKey,
  currentSortKey,
  currentDirection,
  onSort,
  className,
}: SortableTableHeadProps) {
  const isActive = currentSortKey === sortKey;

  return (
    <TableHead
      className={cn(
        "cursor-pointer select-none hover:bg-muted/50 transition-colors",
        className
      )}
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center gap-1">
        <span>{children}</span>
        {isActive && currentDirection === "asc" ? (
          <ArrowUp className="h-3.5 w-3.5 text-foreground" />
        ) : isActive && currentDirection === "desc" ? (
          <ArrowDown className="h-3.5 w-3.5 text-foreground" />
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </div>
    </TableHead>
  );
}
