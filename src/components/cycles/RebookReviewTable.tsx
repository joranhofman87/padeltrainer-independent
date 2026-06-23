import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle } from 'lucide-react';
import { formatPrice } from '@/lib/pricing';

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
}

/**
 * Step-2 review table for the rebook wizards: per group the weekday/time + roster
 * (names, with a warning on anyone missing an email), the holiday-adjusted session
 * count, and the projected invoice total. Falls back to plain counts when the
 * (not-yet-redeployed) edge function omits the rich fields.
 */
export function RebookReviewTable({
  groups,
  noEmailTotal = 0,
  grandInvoiceTotal = 0,
  locationName,
  ackNoEmail,
  onAckChange,
}: Props) {
  const { t } = useTranslation('cycles');
  // Detailed = the redeployed edge fn returned the rich fields. Otherwise degrade
  // to the basic weekday/time + player/session counts shown before this change.
  const detailed = groups.some((g) => Array.isArray(g.roster) || g.invoiceTotal != null);
  const totalPlayers = groups.reduce((s, g) => s + g.players, 0);
  const totalSessions = groups.reduce((s, g) => s + g.sessions, 0);
  const noEmailPlayers = groups.flatMap((g) =>
    (g.roster ?? [])
      .filter((r) => !r.hasEmail)
      .map((r) => ({ name: r.name, group: `${g.weekday} ${g.time}` })),
  );

  return (
    <div className="space-y-3">
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
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
              return (
                <TableRow key={i}>
                  <TableCell className="align-top">
                    <div className="font-medium capitalize">
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
                  </TableCell>
                  <TableCell className="text-center align-top tabular-nums">{g.sessions}</TableCell>
                  {detailed && (
                    <TableCell className="text-right align-top tabular-nums whitespace-nowrap">
                      {g.invoiceTotal != null ? formatPrice(g.invoiceTotal) : '—'}
                      {g.pricePerSession != null && (
                        <div className="text-[10px] text-muted-foreground">
                          {g.splitPayment
                            ? t('rebookReview.breakdownSplit', '{{p}} × {{s}} (gedeeld)', {
                                p: formatPrice(g.pricePerSession),
                                s: g.sessions,
                              })
                            : t('rebookReview.breakdown', '{{p}} × {{s}} × {{n}}', {
                                p: formatPrice(g.pricePerSession),
                                s: g.sessions,
                                n: g.players,
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
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {t('rebookReview.totals', '{{groups}} groepen · {{players}} spelers · {{sessions}} sessies', {
            groups: groups.length,
            players: totalPlayers,
            sessions: totalSessions,
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
