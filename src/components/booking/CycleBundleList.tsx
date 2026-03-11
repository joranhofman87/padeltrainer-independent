import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, Euro, MapPin, Repeat } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { formatPrice } from '@/lib/pricing';

interface CyclusBundle {
  cyclus_id: string;
  cyclus_name: string;
  slots: Array<{ id: string; start_time: string; end_time: string; price_per_session?: number | null }>;
  totalPrice: number;
  firstDate: string;
  lastDate: string;
  location?: { id: string; name: string; city: string; street_address: string | null } | null;
  min_group_size?: number;
}

interface CycleBundleListProps {
  bundles: CyclusBundle[];
  selectedCyclusId: string | null;
  onSelect: (bundle: CyclusBundle) => void;
}

export function CycleBundleList({ bundles, selectedCyclusId, onSelect }: CycleBundleListProps) {
  if (bundles.length === 0) return null;

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Repeat className="h-5 w-5 text-primary" />
        Training Cycles
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {bundles.map((cyclus) => (
          <Card
            key={cyclus.cyclus_id}
            className={`transition-all ${
              selectedCyclusId === cyclus.cyclus_id
                ? 'ring-2 ring-primary border-primary cursor-pointer'
                : 'hover:border-primary/50 cursor-pointer'
            }`}
            onClick={() => onSelect(cyclus)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Repeat className="h-4 w-4 text-primary" />
                  <span className="font-semibold">{cyclus.cyclus_name}</span>
                </div>
                {selectedCyclusId === cyclus.cyclus_id && (
                  <Check className="h-5 w-5 text-primary" />
                )}
              </div>
              <Badge variant="secondary" className="mb-2">
                {cyclus.slots.length} sessions
              </Badge>
              <p className="text-sm text-muted-foreground mb-2">
                {format(parseISO(cyclus.firstDate), 'MMM d')} - {format(parseISO(cyclus.lastDate), 'MMM d, yyyy')}
              </p>
              {cyclus.location && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                  <MapPin className="h-3 w-3" />
                  {cyclus.location.name}, {cyclus.location.city}
                </p>
              )}
              <div className="flex items-center gap-2 pt-2 border-t mt-2">
                <Euro className="h-4 w-4 text-primary" />
                <span className="font-semibold text-primary">
                  {formatPrice(cyclus.totalPrice)}
                </span>
                <span className="text-xs text-muted-foreground">total</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
