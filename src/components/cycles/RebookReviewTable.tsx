import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataTableCard, compactDataTableClass } from '@/components/ui/data-table';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPrice } from '@/lib/pricing';
import type { RebookPaymentMode } from '@/lib/priorityClaims';

export interface RebookRosterEntry {
  name: string;
  hasEmail: boolean;
}

export interface RebookGroupDetail {
  weekday: string;
  time: string;
  players: number;
  sessions: number;
  locationId?: string | null;
  /** Trainer identity + display name (added by the redeployed edge fn). */
  trainerId?: string | null;
  trainerName?: string | null;
  /** Stable per-series key — the include/exclude toggle identity. */
  sourceSeriesKey?: string;
  pricePerSession?: number | null;
  splitPayment?: boolean;
  invoiceTotal?: number | null;
  noEmailCount?: number;
  roster?: RebookRosterEntry[];
}

interface Props {
  groups: RebookGroupDetail[];
  noEmailTotal?: number;
  grandInvoiceTotal?: number;
  /** Resolve a location id to a display name (cohort-by-location mode). */
  locationName?: (id: string | null | undefined) => string | undefined;
  ackNoEmail: boolean;
  onAckChange: (v: boolean) => void;
  /**
   * Interactive mode (cohort wizard): render a keep/remove toggle per session + a
   * per-removal "let these players rebook other freed seats" toggle. Omit the
   * callbacks to keep the table READ-ONLY (new-round wizard).
   */
  interactive?: boolean;
  excludedKeys?: Set<string>;
  secondBucketKeys?: Set<string>;
  onToggleExcluded?: (seriesKey: string) => void;
  onToggleSecondBucket?: (seriesKey: string) => void;
  /** Server-authoritative totals (interactive mode) — the distinct player count can't be
   *  re-summed client-side (a player in two series must count once). */
  summary?: { groups: number; players: number; sessions: number };
  /** Round-level payment mode. In 'upfront' one captain pays the whole court, so the per-group
   *  breakdown reads "P × S (whole group)" — never "× N". */
  paymentMode?: RebookPaymentMode;
}

/**
 * Step-2 review table for the rebook wizards: per group the weekday/time (+ trainer)
 * + roster (names, with a warning on anyone missing an email), the holiday-adjusted
 * session count, and the projected invoice total. Falls back to plain counts when the
 * (not-yet-redeployed) edge function omits the rich fields. In interactive mode the
 * owner can drop sessions and choose whether the dropped players keep early-booking access.
 */
export function RebookReviewTable({
  groups,
  noEmailTotal = 0,
  grandInvoiceTotal = 0,
  locationName,
  ackNoEmail,
  onAckChange,
  interactive = false,
  excludedKeys,
  secondBucketKeys,
  onToggleExcluded,
  onToggleSecondBucket,
  summary,
  paymentMode,
}: Props) {
  const { t } = useTranslation('cycles');
  // Detailed = the redeployed edge fn returned the rich fields. Otherwise degrade
  // to the basic weekday/time + player/session counts shown before this change.
  const detailed = groups.some((g) => Array.isArray(g.roster) || g.invoiceTotal != null);
  const isExcluded = (g: RebookGroupDetail) => !!(interactive && g.sourceSeriesKey && excludedKeys?.has(g.sourceSeriesKey));
  const included = groups.filter((g) => !isExcluded(g));
  const totalPlayers = included.reduce((s, g) => s + g.players, 0);
  const totalSessions = included.reduce((s, g) => s + g.sessions, 0);
  const noEmailPlayers = included.flatMap((g) =>
    (g.roster ?? [])
      .filter((r) => !r.hasEmail)
      .map((r) => ({ name: r.name, group: `${g.weekday} ${g.time}` })),
  );

  return (
    <div className="space-y-3">
      {/* Escape hatch: the shared card frame + compact header/density, but the multi-line roster
          cell means rows must grow to content (the strict 40px clamp would clip player names). */}
      <DataTableCard desktopOnly={false}>
        <Table className={cn(compactDataTableClass, '[&_td]:!h-auto [&_td]:!max-h-none [&_td]:!overflow-visible [&_td]:!py-1.5 [&_td]:!align-top')}>
          <TableHeader>
            <TableRow>
              {interactive && <TableHead className="w-10">{t('rebookReview.keep', 'Mee')}</TableHead>}
              <TableHead>{t('rebookReview.group', 'Groep & spelers')}</TableHead>
              <TableHead className="text-center whitespace-nowrap">{t('rebookReview.sessions', 'Sessies')}</TableHead>
              {detailed && (
                <TableHead className="text-right whitespace-nowrap">{t('rebookReview.invoice', 'Factuur')}</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g, i) => {
              const loc = locationName?.(g.locationId);
              const excluded = isExcluded(g);
              const key = g.sourceSeriesKey;
              const moved = !!(key && secondBucketKeys?.has(key));
              return (
                <TableRow key={key ?? i} className={excluded ? 'opacity-50' : ''}>
                  {interactive && (
                    <TableCell className="align-top">
                      {key && (
                        <Checkbox
                          checked={!excluded}
                          aria-label={t('rebookReview.keep', 'Mee')}
                          onCheckedChange={() => onToggleExcluded?.(key)}
                        />
                      )}
                    </TableCell>
                  )}
                  <TableCell className="align-top">
                    <div className={cn('font-medium capitalize', excluded && 'line-through')}>
                      {g.trainerName ? `${g.trainerName} · ` : ''}
                      {g.weekday} {g.time}
                      {loc ? ` · ${loc}` : ''}
                    </div>
                    {Array.isArray(g.roster) ? (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {g.roster.map((r, j) => (
                          <span key={j} className={r.hasEmail ? '' : 'font-medium text-destructive'}>
                            {r.name}
                            {!r.hasEmail && ' ⚠'}
                            {j < (g.roster?.length ?? 0) - 1 ? ',' : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('rebookReview.playersCount', '{{n}} spelers', { n: g.players })}
                      </div>
                    )}
                    {interactive && excluded && key && (
                      <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-xs">
                        <Checkbox checked={moved} onCheckedChange={() => onToggleSecondBucket?.(key)} />
                        <span>{t('rebookReview.moveToSecondBucket', 'Deze spelers mogen andere vrijgekomen plekken boeken')}</span>
                      </label>
                    )}
                  </TableCell>
                  <TableCell className="text-center align-top tabular-nums">{g.sessions}</TableCell>
                  {detailed && (
                    <TableCell className="text-right align-top tabular-nums whitespace-nowrap">
                      {g.invoiceTotal != null ? formatPrice(g.invoiceTotal) : '—'}
                      {g.pricePerSession != null && (
                        <div className="text-[10px] text-muted-foreground">
                          {/* A rebook group always pays the court price ONCE (P × S) — upfront the
                              captain pays the whole, deferred it's split across the group. Never × N. */}
                          {paymentMode === 'upfront'
                            ? t('rebookReview.breakdownUpfront', '{{p}} × {{s}} (hele groep)', {
                                p: formatPrice(g.pricePerSession),
                                s: g.sessions,
                              })
                            : t('rebookReview.breakdownSplit', '{{p}} × {{s}} (gedeeld)', {
                                p: formatPrice(g.pricePerSession),
                                s: g.sessions,
                              })}
                        </div>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTableCard>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {t('rebookReview.totals', '{{groups}} groepen · {{players}} spelers · {{sessions}} sessies', {
            groups: summary?.groups ?? included.length,
            players: summary?.players ?? totalPlayers,
            sessions: summary?.sessions ?? totalSessions,
          })}
        </span>
        {detailed && grandInvoiceTotal > 0 && (
          <span className="font-semibold">
            {t('rebookReview.grandTotal', 'Totaal indien iedereen accepteert: {{amount}}', {
              amount: formatPrice(grandInvoiceTotal),
            })}
          </span>
        )}
      </div>

      {detailed && noEmailTotal > 0 && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t('rebookReview.noEmailTitle', '{{n}} spelers hebben geen e-mailadres en krijgen GEEN uitnodiging:', {
              n: noEmailTotal,
            })}
          </div>
          <ul className="list-disc space-y-0.5 pl-6 text-xs text-muted-foreground">
            {noEmailPlayers.map((p, i) => (
              <li key={i}>
                {p.name} <span className="capitalize opacity-70">({p.group})</span>
              </li>
            ))}
          </ul>
          <label className="flex cursor-pointer items-center gap-2 pt-1 text-sm">
            <Checkbox checked={ackNoEmail} onCheckedChange={(v) => onAckChange(Boolean(v))} />
            <span>
              {t('rebookReview.noEmailAck', 'Ik begrijp dat {{n}} spelers geen e-mail krijgen', { n: noEmailTotal })}
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
