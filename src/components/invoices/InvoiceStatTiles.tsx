import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';

export interface InvoiceStatTile {
  label: string;
  value: ReactNode;
}

/**
 * The 3-up KPI tile row above the trainer + academy invoice lists. Markup was byte-identical in both
 * pages; the VALUE SOURCE stays per-page (trainer's unscoped summary vs academy's filter-following
 * cards), so the values + labels are injected as props — this component never owns a query.
 */
export function InvoiceStatTiles({ tiles }: { tiles: InvoiceStatTile[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      {tiles.map((tile, i) => (
        <Card key={i}>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{tile.label}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{tile.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
