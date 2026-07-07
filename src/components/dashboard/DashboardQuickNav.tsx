import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface QuickNavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  count?: number;
}

/** Compact grid of navigation tiles — the replacement for the old preview tables. Each tile
 *  links to the full page (where the detail already lives), with an optional count. */
export function DashboardQuickNav({ items, className }: { items: QuickNavItem[]; className?: string }) {
  const navigate = useNavigate();
  return (
    <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4', className)}>
      {items.map((item) => (
        <button
          key={item.to}
          type="button"
          aria-label={item.label}
          onClick={() => navigate(item.to)}
          className="flex items-center gap-3 rounded-lg border border-border/80 bg-card px-4 py-3 text-left shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--navy-50))]">
            <item.icon className="h-4 w-4 text-[hsl(var(--navy-600))]" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{item.label}</p>
            {typeof item.count === 'number' && (
              <p className="text-xs text-muted-foreground tabular-nums">{item.count}</p>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
