import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface EarningsBookingRowProps {
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  amount: string;
  amountClassName?: string;
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EarningsBookingRow({
  title,
  subtitle,
  meta,
  amount,
  amountClassName,
  badges,
  actions,
  className,
}: EarningsBookingRowProps) {
  return (
    <Card className={cn('overflow-hidden border-border/80 shadow-sm', className)}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <p className="font-medium text-[hsl(var(--navy-900))]">{title}</p>
              {badges}
            </div>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
            {meta && <div className="mt-2 text-sm text-muted-foreground">{meta}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-start gap-3 sm:flex-row sm:items-center">
            <p className={cn('font-display text-xl font-semibold tabular-nums text-[hsl(var(--navy-900))]', amountClassName)}>
              {amount}
            </p>
            {actions}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
