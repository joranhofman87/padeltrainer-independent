import { useTranslation } from 'react-i18next';
import { MapPin, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { differenceInWeeks } from 'date-fns';
import { Button } from '@/components/ui/button';
import type { Cycle, PriceTableRow, CyclusOption } from '@/lib/cycles';

/** Renders HTML without React tracking inner DOM nodes, preventing reconciliation crashes from third-party scripts. */
function SafeHTML({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = html;
  }, [html]);
  return <div ref={ref} className={className} />;
}

interface CycleDetailDisplayProps {
  cycle: Cycle;
  hideLocation?: boolean;
}

export default function CycleDetailDisplay({ cycle, hideLocation = false }: CycleDetailDisplayProps) {
  const { t, i18n } = useTranslation('cycles');
  const [showTerms, setShowTerms] = useState(false);

  const priceTable = cycle.price_table as PriceTableRow[] | null;
  const cyclusOptions = (cycle.settings?.cyclus_options as CyclusOption[] | undefined) || [];
  const durationOptions = (cycle.settings?.duration_options as number[] | undefined) || [];
  const priceColumns = (cycle.settings?.price_columns as string[] | undefined) || [];
  const hasCyclusOptions = cyclusOptions.length > 0;
  const hasDurationOptions = durationOptions.length > 0;
  const hasPriceTable = !hasCyclusOptions && priceTable && priceTable.length > 0;

  // Compute number of weeks from cycle dates as fallback
  const numberOfWeeks = useMemo(() => {
    if (hasDurationOptions) return 0; // duration options handle their own columns
    if (!cycle.start_date || !cycle.end_date) return 0;
    return Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date))));
  }, [cycle.start_date, cycle.end_date, hasDurationOptions]);
  const hasTerms = !!cycle.terms;
  const hasLocation = !hideLocation && !!cycle.location;
  const hasDescription = !!cycle.description;

  if (!hasLocation && !hasDescription && !hasTerms && !hasPriceTable && !hasCyclusOptions && !hasDurationOptions) {
    return null;
  }

  const currencyFormatter = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: cycle.currency || 'EUR',
  });

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
        <SafeHTML
          html={cycle.description!}
          className="text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none"
        />
      )}

      {/* Cyclus Options Table (enhanced) */}
      {hasCyclusOptions && (
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted/50 px-3 py-2 text-sm font-medium">
            {t('detail.priceTable', 'Tarieven')}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('detail.cyclusOption', 'Optie')}</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('detail.sessions', 'Lessen')}</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('detail.weeks', 'Weken')}</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('detail.pricePerSession', 'Per les')}</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('detail.totalPrice', 'Totaal')}</th>
              </tr>
            </thead>
            <tbody>
              {cyclusOptions.map((opt, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{opt.label}</td>
                  <td className="px-3 py-2 text-right">{opt.number_of_sessions}</td>
                  <td className="px-3 py-2 text-right">{opt.number_of_weeks || '–'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{currencyFormatter.format(opt.price_per_session)}</td>
                  <td className="px-3 py-2 text-right font-medium whitespace-nowrap">{currencyFormatter.format(opt.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Price Table with Duration Columns */}
      {hasPriceTable && hasDurationOptions && (
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted/50 px-3 py-2 text-sm font-medium">
            {t('detail.priceTable', 'Tarieven')}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('detail.type', 'Type')}</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('detail.pricePerSession', 'Per les')}</th>
                {priceColumns.map(col => (
                  <th key={`per-${col}`} className="px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">{col}</th>
                ))}
                {[...durationOptions].sort((a, b) => a - b).flatMap(weeks => [
                  <th key={`w-${weeks}`} className="px-3 py-2 text-right font-medium text-primary whitespace-nowrap">
                    {t('detail.weeksColumn', '{{count}} weken', { count: weeks })}
                  </th>,
                  ...priceColumns.map(col => (
                    <th key={`w-${weeks}-${col}`} className="px-3 py-2 text-right font-medium text-primary whitespace-nowrap">
                      {col} {weeks}w
                    </th>
                  )),
                ])}
              </tr>
            </thead>
            <tbody>
              {priceTable!.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{row.label}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{currencyFormatter.format(row.price)}</td>
                  {priceColumns.map(col => {
                    const ep = (row.extra_prices || []).find(ep => ep.column_name === col);
                    return (
                      <td key={`per-${col}`} className="px-3 py-2 text-right whitespace-nowrap">
                        {ep ? currencyFormatter.format(ep.price) : '–'}
                      </td>
                    );
                  })}
                  {[...durationOptions].sort((a, b) => a - b).flatMap(weeks => [
                    <td key={`w-${weeks}`} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {currencyFormatter.format(row.price * weeks)}
                    </td>,
                    ...priceColumns.map(col => {
                      const ep = (row.extra_prices || []).find(ep => ep.column_name === col);
                      return (
                        <td key={`w-${weeks}-${col}`} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                          {ep ? currencyFormatter.format(ep.price * weeks) : '–'}
                        </td>
                      );
                    }),
                  ])}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Simple Price Table (fallback when no duration options) */}
      {hasPriceTable && !hasDurationOptions && (
        <div className="rounded-lg border overflow-hidden">
          <div className="bg-muted/50 px-3 py-2 text-sm font-medium">
            {t('detail.priceTable', 'Tarieven')}
          </div>
          <table className="w-full text-sm">
            {priceColumns.length > 0 && (
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('detail.type', 'Type')}</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">{t('detail.pricePerSession', 'Per les')}</th>
                  {priceColumns.map(col => (
                    <th key={col} className="px-3 py-2 text-right font-medium text-muted-foreground whitespace-nowrap">{col}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {priceTable!.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{row.label}</td>
                  <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    {currencyFormatter.format(row.price)}
                  </td>
                  {priceColumns.map(col => {
                    const ep = (row.extra_prices || []).find(ep => ep.column_name === col);
                    return (
                      <td key={col} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                        {ep ? currencyFormatter.format(ep.price) : '–'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Duration Options (standalone, only when no price table) */}
      {!hasPriceTable && hasDurationOptions && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
          <span className="font-medium text-foreground">{t('detail.durationOptions', 'Beschikbare duur')}:</span>
          {[...durationOptions].sort((a, b) => a - b).map(weeks => (
            <span key={weeks} className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
              {weeks} {t('detail.weeks', 'weken')}
            </span>
          ))}
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
