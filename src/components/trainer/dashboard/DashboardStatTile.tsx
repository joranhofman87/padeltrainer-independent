import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DashboardStatTileProps {
  label: string;
  value: string;
  icon: LucideIcon;
  onClick?: () => void;
  highlight?: boolean;
  loading?: boolean;
  subtext?: string;
  endSlot?: ReactNode;
}

export function DashboardStatTile({
  label,
  value,
  icon: Icon,
  onClick,
  highlight = false,
  loading = false,
  subtext,
  endSlot,
}: DashboardStatTileProps) {
  const Component = onClick ? 'button' : 'div';

  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border bg-card px-4 py-3.5 text-left shadow-sm transition-colors',
        highlight ? 'border-[hsl(var(--brand-200))] border-l-4 border-l-[hsl(var(--brand-500))]' : 'border-border/80',
        onClick && 'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-[hsl(var(--navy-900))]">
            {loading ? '—' : value}
          </p>
          {subtext && <p className="mt-0.5 text-[11px] text-muted-foreground">{subtext}</p>}
        </div>
        {endSlot ?? (
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              highlight ? 'bg-[hsl(var(--brand-50))]' : 'bg-[hsl(var(--navy-50))]',
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4',
                highlight ? 'text-[hsl(var(--brand-600))]' : 'text-[hsl(var(--navy-600))]',
              )}
            />
          </div>
        )}
      </div>
    </Component>
  );
}
