import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Users, Trash2, CalendarDays, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useCycleDetail, type CycleDetailSlot } from '@/lib/cycleDetail';
import { paymentStatusBadgeVariant, type CyclusGroupPaymentStatus } from '@/lib/cyclusGroupPayment';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { syncSplitCountForCycle } from '@/lib/invoiceSync';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { logger } from '@/lib/logger';

export interface CycleDetailViewProps {
  cycleId: string;
  /** Navigate to a single session (the slot-detail page) — the per-slot edit + coaching-notes surface. */
  onOpenSlot: (slotId: string) => void;
  /**
   * Edit/delete capability. Academy + trainer pass true; club passes false → view-only. Gates the
   * cycle-scope action CTAs. (Edit-whole-cycle + price land in follow-up slices; 9c-1 wires Delete.)
   */
  canEdit?: boolean;
  /** Called after a successful cycle-scope mutation, so the wrapper can refetch its own surfaces. */
  onMutated?: () => void;
  /** i18n namespace (default 'cycles' — the neutral home for cycle UI strings). */
  namespace?: string;
}

/**
 * The cycle-detail centerpiece view (Slice 9): open a cycle → see all its sessions + the players in
 * each → drill into one session or (9c) edit the whole cycle. Neutral/shared across academy + trainer
 * (all role differences arrive as props; no cross-role imports). Read-only by itself — the cycle-scope
 * action handlers are injected by the role wrapper.
 */
export function CycleDetailView({
  cycleId,
  onOpenSlot,
  canEdit = false,
  onMutated,
  namespace = 'cycles',
}: CycleDetailViewProps) {
  const { t, i18n } = useTranslation(namespace);
  const dateLocale = i18n.language?.startsWith('nl') ? nl : enUS;
  const { data, isLoading, isError } = useCycleDetail(cycleId);
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Future (not-yet-started) sessions are the whole-cycle delete scope (matches the slot-detail
  // "future only" rule). The RPC keeps any still-booked session; we only ever remove empty ones.
  const futureSlotIds = useMemo(
    () => (data?.slots ?? []).filter((s) => new Date(s.start_time).getTime() >= Date.now()).map((s) => s.id),
    [data],
  );

  if (isLoading) return <CycleDetailSkeleton />;
  if (isError || !data) {
    return <StateCard icon={<AlertCircle className="h-5 w-5 text-destructive" />} message={t('detail.loadError')} />;
  }

  const { cycle, slots, roster, totalSlots, totalPlayers } = data;
  if (!cycle && totalSlots === 0) {
    return (
      <StateCard
        icon={<AlertCircle className="h-5 w-5 text-muted-foreground" />}
        title={t('detail.notFoundTitle')}
        message={t('detail.notFoundDescription')}
      />
    );
  }

  const title = cycle?.name || t('detail.untitledCycle');
  const statusKey = cycle?.status;
  // Period is derived from the actual sessions (the source of truth — cycle dates can be stale),
  // falling back to the cycle's stored dates when there are no slots.
  const periodStart = slots[0]?.start_time ?? cycle?.start_date ?? null;
  const periodEnd = slots[slots.length - 1]?.end_time ?? cycle?.end_date ?? null;
  const locationName = cycle?.location?.name ?? null;

  const handleDeleteCycle = async () => {
    setDeleting(true);
    try {
      // Atomic, booked-slot-protecting delete (F2). cycleId drives the in-transaction split-count
      // stamp; the RPC keeps any session that still holds an active booking (reported as
      // protectedCount) so only empty sessions are ever removed.
      const res = await applySlotDeleteToCycle(cycleId, futureSlotIds);
      if (res.deletedCount > 0) {
        // The RPC only stamps invoices.split_count — it does NOT rebuild line-item amounts. Rebuild
        // them now (matches the slot-detail delete path + the RPC's documented contract). Non-fatal:
        // the delete already committed, so a resync hiccup must not surface as a delete failure.
        try {
          await syncSplitCountForCycle(cycleId);
        } catch (e) {
          logger.error('Failed to sync split count after cycle delete', e as Error);
        }
      }
      const parts: string[] = [];
      if (res.deletedCount > 0) parts.push(t('detail.delete.removed', { count: res.deletedCount }));
      if (res.protectedCount > 0) parts.push(t('detail.delete.kept', { count: res.protectedCount }));
      if (parts.length === 0) parts.push(t('detail.delete.nothing'));
      const message = parts.join(' · ');
      // Close first so the (now-disabled) confirm can't be re-fired and any parent refetch happens
      // with the dialog already dismissed.
      setDeleteOpen(false);
      if (res.deletedCount > 0) toast.success(message);
      else toast(message);
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.delete.error')));
    } finally {
      setDeleting(false);
    }
  };

  const fmtDayTime = (slot: CycleDetailSlot) => {
    const start = parseISO(slot.start_time);
    const end = parseISO(slot.end_time);
    return `${format(start, 'EEEE d MMM', { locale: dateLocale })} · ${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}`;
  };
  const fmtPeriod = (iso: string | null, withYear = false) =>
    iso ? format(parseISO(iso), withYear ? 'd MMM yyyy' : 'd MMM', { locale: dateLocale }) : '—';
  const occupancy = (slot: CycleDetailSlot) => `${slot.bookedCount}/${slot.max_participants ?? '∞'}`;
  const paymentLabel = (status: CyclusGroupPaymentStatus) =>
    status === 'all_paid'
      ? t('detail.payment.allPaid')
      : status === 'has_unpaid'
        ? t('detail.payment.hasUnpaid')
        : t('detail.payment.noPlayers');
  const renderPayment = (status: CyclusGroupPaymentStatus) =>
    status === 'no_players' ? (
      <span className="text-muted-foreground text-sm">—</span>
    ) : (
      <Badge variant={paymentStatusBadgeVariant(status)}>{paymentLabel(status)}</Badge>
    );

  const playerChips = (slot: CycleDetailSlot, size: 'sm' | 'xs') =>
    slot.playerNames.length > 0 ? (
      <div className="flex items-center gap-1.5 min-w-0" title={slot.playerNames.join(', ')}>
        <Users className={`${size === 'sm' ? 'h-3.5 w-3.5' : 'h-3 w-3'} text-muted-foreground shrink-0`} />
        <span className={`${size === 'sm' ? 'text-sm' : 'text-xs'} truncate`}>{slot.playerNames.join(', ')}</span>
      </div>
    ) : (
      <span className={`${size === 'sm' ? 'text-sm' : 'text-xs'} text-muted-foreground`}>{t('detail.sessions.noPlayers')}</span>
    );

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold truncate">{title}</h1>
                {statusKey && <Badge variant="secondary">{t(`status.${statusKey}`)}</Badge>}
              </div>
              <p className="text-sm text-muted-foreground">
                {fmtPeriod(periodStart)} → {fmtPeriod(periodEnd, true)}
                {locationName && <> · {locationName}</>}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('detail.summary', { players: totalPlayers, sessions: totalSlots })}
              </p>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDeleteOpen(true)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  {t('detail.deleteCycle')}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Sessions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            {t('detail.sessions.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:px-2 sm:pb-2">
          {slots.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('detail.sessions.empty')}</p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('detail.sessions.when')}</TableHead>
                      <TableHead className="text-center">{t('detail.sessions.occupancy')}</TableHead>
                      <TableHead>{t('detail.sessions.players')}</TableHead>
                      <TableHead>{t('detail.sessions.payment')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slots.map((slot) => (
                      <TableRow key={slot.id} className="cursor-pointer hover:bg-muted/50" onClick={() => onOpenSlot(slot.id)}>
                        <TableCell className="whitespace-nowrap text-sm font-medium capitalize">{fmtDayTime(slot)}</TableCell>
                        <TableCell className="text-center whitespace-nowrap">
                          <Badge variant="secondary">{occupancy(slot)}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[280px]">{playerChips(slot, 'sm')}</TableCell>
                        <TableCell className="whitespace-nowrap">{renderPayment(slot.paymentStatus)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile list */}
              <div className="md:hidden divide-y">
                {slots.map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    aria-label={fmtDayTime(slot)}
                    onClick={() => onOpenSlot(slot.id)}
                    className="w-full text-left p-3 space-y-1.5 hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium capitalize">{fmtDayTime(slot)}</span>
                      <Badge variant="secondary">{occupancy(slot)}</Badge>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      {playerChips(slot, 'xs')}
                      {renderPayment(slot.paymentStatus)}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Roster */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            {t('detail.roster.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {roster.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('detail.roster.empty')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {roster.map((p, i) => (
                <li key={`${p.name}-${i}`}>
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    {p.name}
                    <span className="text-muted-foreground">{t('detail.roster.sessionCount', { count: p.sessionCount })}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Delete-cycle confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={(o) => !deleting && setDeleteOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.delete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('detail.delete.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t('detail.delete.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteCycle()}
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t('detail.delete.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CycleDetailSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 sm:p-6 space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-32" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StateCard({ icon, title, message }: { icon: ReactNode; title?: string; message: string }) {
  return (
    <Card>
      <CardContent className="py-12 flex flex-col items-center gap-2 text-center">
        {icon}
        {title && <p className="font-medium">{title}</p>}
        <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
      </CardContent>
    </Card>
  );
}
