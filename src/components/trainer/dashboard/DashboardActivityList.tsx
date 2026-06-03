import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface SectionHeaderProps {
  title: string;
  viewAllLabel: string;
  onViewAll: () => void;
}

export function DashboardSectionHeader({ title, viewAllLabel, onViewAll }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
      <h2 className="font-display text-base font-semibold text-[hsl(var(--navy-900))]">{title}</h2>
      <Button variant="ghost" size="sm" className="h-8 shrink-0 text-muted-foreground" onClick={onViewAll}>
        {viewAllLabel}
        <ArrowRight className="ml-1 h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

interface DashboardActivityRowProps {
  primary: string;
  secondary?: string;
  meta?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}

export function DashboardActivityRow({ primary, secondary, meta, trailing, className }: DashboardActivityRowProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 border-b border-border/50 px-4 py-3 last:border-0',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[hsl(var(--navy-900))]">{primary}</p>
        {secondary && <p className="mt-0.5 truncate text-xs text-muted-foreground">{secondary}</p>}
        {meta && <p className="mt-1 text-xs text-muted-foreground">{meta}</p>}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

export function DashboardPaymentBadge({
  status,
  variant,
}: {
  status: string;
  variant: 'success' | 'warning' | 'muted';
}) {
  return (
    <Badge variant={variant} className="text-xs capitalize">
      {status}
    </Badge>
  );
}
