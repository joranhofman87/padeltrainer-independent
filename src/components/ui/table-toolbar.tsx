import { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface TableToolbarProps {
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Filter controls (Selects, etc.) rendered after the search input. */
  children?: ReactNode;
  /** Right-side slot (e.g. Columns dropdown, CSV export button). */
  trailing?: ReactNode;
  className?: string;
}

/**
 * Standard toolbar for list/table pages: search first (left), filters next,
 * trailing slot pushed to the right.
 */
export function TableToolbar({
  searchPlaceholder,
  searchValue,
  onSearchChange,
  children,
  trailing,
  className,
}: TableToolbarProps) {
  const showSearch = onSearchChange !== undefined;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {showSearch && (
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={searchValue ?? ''}
            onChange={(e) => onSearchChange?.(e.target.value)}
            className="pl-9"
          />
        </div>
      )}
      {children}
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
