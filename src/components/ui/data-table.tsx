import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { dataTableCardContentClass } from '@/components/ui/app-page';
import { cn } from '@/lib/utils';

/** Compact operational table density (h-10 rows, truncation-friendly). */
export const compactDataTableClass =
  'min-w-[960px] [&_td]:h-10 [&_td]:max-h-10 [&_td]:py-0 [&_td]:px-3 [&_td]:align-middle [&_td]:overflow-hidden [&_th]:py-1 [&_th]:px-3 [&_th]:h-9 [&_tbody_tr]:h-10 text-sm';

export type DataTableCardProps = {
  children: ReactNode;
  /** Optional mobile list rendered below the desktop scroll region. */
  mobile?: ReactNode;
  className?: string;
  testId?: string;
  /** When true (default), table scroll is md+ only; set false for dashboard/compact tables. */
  desktopOnly?: boolean;
};

/**
 * Flush card wrapper for desktop data tables with horizontal scroll.
 * Presentation-only — no data or filter logic.
 */
export function DataTableCard({
  children,
  mobile,
  className,
  testId,
  desktopOnly = true,
}: DataTableCardProps) {
  return (
    <Card className={cn('overflow-hidden border-border/80 shadow-sm', className)}>
      <CardContent className={dataTableCardContentClass}>
        <div
          className={cn('overflow-x-auto', desktopOnly && 'hidden md:block')}
          data-testid={testId}
        >
          {children}
        </div>
        {mobile}
      </CardContent>
    </Card>
  );
}
