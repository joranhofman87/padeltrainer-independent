import type { ReactNode } from 'react';
import { StatTile } from '@/components/ui/stat-tile';

export interface InvoiceStatTile {
  label: string;
  value: ReactNode;
}

/**
 * The 3-up KPI tile row above the trainer + academy invoice lists, standardized on the shared
 * ui/StatTile. The VALUE SOURCE stays per-page (trainer's unscoped summary vs academy's
 * filter-following cards), so the values + labels are injected as props — this component never
 * owns a query.
 */
export function InvoiceStatTiles({ tiles }: { tiles: InvoiceStatTile[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      {tiles.map((tile, i) => (
        <StatTile key={i} label={tile.label} value={tile.value} />
      ))}
    </div>
  );
}
