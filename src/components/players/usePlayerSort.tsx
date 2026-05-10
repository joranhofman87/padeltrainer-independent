import { useMemo, useState, ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type PlayerSortKey = "name" | "email" | "skill" | "addedOn";
export type SortDir = "asc" | "desc";

export interface SortablePlayer {
  full_name?: string | null;
  email?: string | null;
  skill_rating?: number | null;
  created_at?: string | null;
}

const compareString = (a?: string | null, b?: string | null) => {
  const aEmpty = !a;
  const bEmpty = !b;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // empty always last
  if (bEmpty) return -1;
  return a!.localeCompare(b!, undefined, { sensitivity: "base" });
};

const compareNumber = (a?: number | null, b?: number | null) => {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // null always last
  if (bEmpty) return -1;
  return (a as number) - (b as number);
};

const compareDate = (a?: string | null, b?: string | null) => {
  const aT = a ? new Date(a).getTime() : NaN;
  const bT = b ? new Date(b).getTime() : NaN;
  const aEmpty = isNaN(aT);
  const bEmpty = isNaN(bT);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return aT - bT;
};

export function usePlayerSort<T extends SortablePlayer>(players: T[]) {
  const [sortKey, setSortKey] = useState<PlayerSortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: PlayerSortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    // third click clears
    setSortKey(null);
    setSortDir("asc");
  };

  const sortedPlayers = useMemo(() => {
    if (!sortKey) return players;
    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...players].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = compareString(a.full_name, b.full_name);
          break;
        case "email":
          cmp = compareString(a.email, b.email);
          break;
        case "skill":
          cmp = compareNumber(a.skill_rating, b.skill_rating);
          break;
        case "addedOn":
          cmp = compareDate(a.created_at, b.created_at);
          break;
      }
      // empty values always last regardless of direction
      const aEmpty =
        (sortKey === "name" && !a.full_name) ||
        (sortKey === "email" && !a.email) ||
        (sortKey === "skill" && (a.skill_rating === null || a.skill_rating === undefined)) ||
        (sortKey === "addedOn" && !a.created_at);
      const bEmpty =
        (sortKey === "name" && !b.full_name) ||
        (sortKey === "email" && !b.email) ||
        (sortKey === "skill" && (b.skill_rating === null || b.skill_rating === undefined)) ||
        (sortKey === "addedOn" && !b.created_at);
      if (aEmpty && !bEmpty) return 1;
      if (bEmpty && !aEmpty) return -1;
      return cmp * dir;
    });
    return sorted;
  }, [players, sortKey, sortDir]);

  return { sortedPlayers, sortKey, sortDir, toggleSort };
}

interface SortableHeaderProps {
  sortKey: PlayerSortKey;
  activeKey: PlayerSortKey | null;
  direction: SortDir;
  onToggle: (key: PlayerSortKey) => void;
  className?: string;
  children: ReactNode;
}

export function SortableHeader({
  sortKey,
  activeKey,
  direction,
  onToggle,
  className,
  children,
}: SortableHeaderProps) {
  const isActive = activeKey === sortKey;
  return (
    <TableHead className={cn("whitespace-nowrap", className)}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded hover:bg-muted/60 transition-colors",
          isActive ? "text-foreground font-medium" : "text-muted-foreground"
        )}
        aria-label={typeof children === "string" ? `Sort by ${children}` : "Sort"}
      >
        <span>{children}</span>
        {isActive ? (
          direction === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
