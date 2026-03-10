import { useTranslation } from 'react-i18next';
import { MapPin, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Cycle, PriceTableRow } from '@/lib/cycles';

interface CycleDetailDisplayProps {
  cycle: Cycle;
  hideLocation?: boolean;
}

export default function CycleDetailDisplay({ cycle }: CycleDetailDisplayProps) {
  const { t, i18n } = useTranslation('cycles');
  const [showTerms, setShowTerms] = useState(false);

  const priceTable = cycle.price_table as PriceTableRow[] | null;
  const hasPriceTable = priceTable && priceTable.length > 0;
  const hasTerms = !!cycle.terms;
  const hasLocation = !!cycle.location;
  const hasDescription = !!cycle.description;

  if (!hasLocation && !hasDescription && !hasTerms && !hasPriceTable) {
    return null;
  }

  return (
    <div className="space-y-3 mt-3">
      {/* Location */}
      {hasLocation && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPin className="h-4 w-4 shrink-0" />
          <span>{cycle.location!.name}{cycle.location!.city ? `, ${cycle.location!.city}` : ''}</span>
        </div>
      )}

      {/* Description */}
      {hasDescription && (
        <div
          className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: cycle.description! }}
        />
      )}

      {/* Price Table */}
      {hasPriceTable && (
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted/50 px-3 py-2 text-sm font-medium">
            {t('detail.priceTable', 'Tarieven')}
          </div>
          <table className="w-full text-sm">
            <tbody>
              {priceTable!.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{row.label}</td>
                  <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    {new Intl.NumberFormat(i18n.language, {
                      style: 'currency',
                      currency: cycle.currency || 'EUR',
                    }).format(row.price)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Terms */}
      {hasTerms && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto p-0 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setShowTerms(!showTerms)}
          >
            <FileText className="h-4 w-4 mr-1" />
            {t('detail.terms', 'Voorwaarden')}
            {showTerms ? <ChevronUp className="h-4 w-4 ml-1" /> : <ChevronDown className="h-4 w-4 ml-1" />}
          </Button>
          {showTerms && (
            <div className="mt-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground whitespace-pre-wrap">
              {cycle.terms}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
