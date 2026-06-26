import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Users, Trash2, Euro, Pencil, CalendarDays, AlertCircle, Loader2 } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import CyclePricingCard from '@/components/cycles/CyclePricingCard';
import { SlotEditForm, type SlotEditFormSlot, type SlotEditFormValues } from '@/components/slots/SlotEditForm';
import { supabase } from '@/lib/supabaseClient';
import { useCycleDetail, type CycleDetailSlot } from '@/lib/cycleDetail';
import { paymentStatusBadgeVariant, type CyclusGroupPaymentStatus } from '@/lib/cyclusGroupPayment';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { syncSplitCountForCycle, syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';
import { updateCyclePricing, applySlotEditToCycle, type ExtraCost } from '@/lib/cycles';
import { buildCycleEditPatch, slotEditBaselineFromSlot } from '@/lib/cycleEditPatch';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { logger } from '@/lib/logger';

export interface CycleDetailViewProps {
  cycleId: string;
  /** Navigate to a single session (the slot-detail page) — the per-slot edit + coaching-notes surface. */
  onOpenSlot: (slotId: string) => void;
  /**
   * Edit/delete capability. Academy + trainer pass true; club passes false → view-only. Gates the
   * Edit-whole-cycle + Delete-cycle CTAs.
   */
  canEdit?: boolean;
  /** Cycle-pricing capability — gates the Edit-price CTA + modal. */
  canEditPrice?: boolean;
  /** Academy profile id for the pricing modal's extra-cost preset picker (null/omit for trainer). */
  academyProfileId?: string | null;
  /** Trainer options for the edit-whole-cycle form (academy passes; trainer omits → self only). */
  trainers?: { id: string; name: string }[];
  /** Location options for the edit-whole-cycle form. */
  locations?: { id: string; name: string }[];
  /** Locks the rating picker to the owner's rating system (passed through to SlotEditForm). */
  fixedRatingSystem?: string | null;
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
  canEditPrice = false,
  academyProfileId,
  trainers,
  locations = [],
  fixedRatingSystem,
  onMutated,
  namespace = 'cycles',
}: CycleDetailViewProps) {
  const { t, i18n } = useTranslation(namespace);
  const dateLocale = i18n.language?.startsWith('nl') ? nl : enUS;
  const { data, isLoading, isError } = useCycleDetail(cycleId);
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Cycle-pricing modal state (seeded from the cycle on open).
  const [priceOpen, setPriceOpen] = useState(false);
  const [savingPrice, setSavingPrice] = useState(false);
  const [pricePerSession, setPricePerSession] = useState<number | null>(null);
  const [extraCosts, setExtraCosts] = useState<ExtraCost[]>([]);
  const [splitPayment, setSplitPayment] = useState(false);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  // Edit-whole-cycle modal state. editRepSlot is the representative session (a full row fetched on
  // open) that seeds the form + the change-detection baseline.
  const [editOpen, setEditOpen] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editRepSlot, setEditRepSlot] = useState<SlotEditFormSlot | null>(null);
  // Bumped on every open so the form always remounts + re-inits, even if two reps share a start_time.
  const [editEpoch, setEditEpoch] = useState(0);
  // Future (not-yet-started) sessions are the whole-cycle edit/delete scope (matches the slot-detail
  // "future only" rule). The delete RPC keeps any still-booked session; the edit RPC keeps any slot
  // it would have to shrink below its occupancy.
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

  const openPriceModal = () => {
    // Seed from the cycle's stored pricing (slot price is the source of truth; the cycle row carries
    // the template the bulk editor pushes down).
    setPricePerSession(cycle?.price_per_session ?? null);
    setExtraCosts((cycle?.settings?.extra_costs as ExtraCost[] | undefined) ?? []);
    setSplitPayment(cycle?.settings?.split_payment ?? false);
    setPricesIncludeVat(cycle?.settings?.prices_include_vat ?? true);
    setPriceOpen(true);
  };

  const handleSavePrice = async () => {
    setSavingPrice(true);
    try {
      await updateCyclePricing(cycleId, {
        price_per_session: pricePerSession,
        extra_costs: extraCosts,
        split_payment: splitPayment,
        prices_include_vat: pricesIncludeVat,
      });
      // updateCyclePricing pushes the price onto every slot but does NOT rebuild invoices — resync the
      // affected (unpaid) invoice line items. Non-fatal: the price already saved.
      try {
        await syncInvoicesAfterPriceChange(slots.map((s) => s.id));
      } catch (e) {
        logger.error('Failed to sync invoices after cycle price change', e as Error);
      }
      setPriceOpen(false);
      toast.success(t('detail.price.saved'));
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.price.error')));
    } finally {
      setSavingPrice(false);
    }
  };

  const openEditModal = async () => {
    // Nothing to edit if every session is in the past (the scope is future-only).
    if (futureSlotIds.length === 0) {
      toast(t('detail.edit.noFuture'));
      return;
    }
    // Representative session = the first FUTURE slot (the edit scope). Its current time-of-day is the
    // reference the relative shift is computed against.
    const rep = slots.find((s) => new Date(s.start_time).getTime() >= Date.now()) ?? slots[0];
    if (!rep) return;
    setEditLoading(true);
    try {
      const { data: row, error } = await supabase
        .from('availability_slots')
        .select(
          'start_time, end_time, trainer_id, location_id, max_participants, rating_system, min_rating, max_rating, cyclus_id, cyclus_name, is_public, price_per_session, total_price, split_payment, prices_include_vat, extra_costs',
        )
        .eq('id', rep.id)
        .maybeSingle();
      if (error || !row) throw error ?? new Error('representative slot not found');
      setEditRepSlot({
        start_time: row.start_time,
        end_time: row.end_time,
        trainer_id: row.trainer_id ?? '',
        location_id: row.location_id ?? null,
        max_participants: row.max_participants ?? 4,
        rating_system: row.rating_system ?? null,
        min_rating: row.min_rating ?? null,
        max_rating: row.max_rating ?? null,
        cyclus_id: row.cyclus_id ?? null,
        cyclus_name: row.cyclus_name ?? null,
        is_public: row.is_public ?? true,
        price_per_session: row.price_per_session ?? null,
        total_price: row.total_price ?? null,
        split_payment: row.split_payment ?? false,
        prices_include_vat: row.prices_include_vat ?? true,
        extra_costs: (row.extra_costs as ExtraCost[] | null) ?? null,
      });
      setEditEpoch((e) => e + 1);
      setEditOpen(true);
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.edit.loadError')));
    } finally {
      setEditLoading(false);
    }
  };

  const handleSaveEdit = async (values: SlotEditFormValues) => {
    if (!editRepSlot || savingEdit) return; // guard against a fast double-submit
    // Diff against the representative slot → only changed fields go in the patch (omitted keys are
    // kept per-slot, so a time-only edit can't reshape another session). See cycleEditPatch.ts.
    const patch = buildCycleEditPatch(values, slotEditBaselineFromSlot(editRepSlot));
    if (Object.keys(patch).length === 0) {
      setEditOpen(false);
      toast(t('detail.edit.nothing'));
      return;
    }
    setSavingEdit(true);
    try {
      // No invoice resync here: this is a NON-price edit (time/trainer/location/capacity). Billing
      // reads slot price × bookings, and split_count is player-count-based — none of which this edit
      // touches (the capacity guard blocks any shrink below occupancy rather than dropping players).
      const res = await applySlotEditToCycle(cycleId, futureSlotIds, patch);
      const parts: string[] = [];
      if (res.updatedCount > 0) parts.push(t('detail.edit.updated', { count: res.updatedCount }));
      if (res.blockedCount > 0) parts.push(t('detail.edit.blocked', { count: res.blockedCount }));
      if (parts.length === 0) parts.push(t('detail.edit.nothing'));
      const message = parts.join(' · ');
      setEditOpen(false);
      // The capacity guard is all-or-nothing, so updatedCount XOR blockedCount. A blocked result means
      // NOTHING changed → surface it as an error, not a benign toast.
      if (res.updatedCount > 0) toast.success(message);
      else if (res.blockedCount > 0) toast.error(message);
      else toast(message);
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.edit.error')));
    } finally {
      setSavingEdit(false);
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
            {(canEdit || canEditPrice) && (
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                {canEdit && (
                  <Button variant="default" size="sm" onClick={() => void openEditModal()} disabled={editLoading}>
                    {editLoading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Pencil className="h-4 w-4 mr-1.5" />}
                    {t('detail.editWholeCycle')}
                  </Button>
                )}
                {canEditPrice && (
                  <Button variant="outline" size="sm" onClick={openPriceModal}>
                    <Euro className="h-4 w-4 mr-1.5" />
                    {t('detail.editPrice')}
                  </Button>
                )}
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteOpen(true)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    {t('detail.deleteCycle')}
                  </Button>
                )}
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

      {/* Edit-cycle-pricing modal */}
      <Dialog open={priceOpen} onOpenChange={(o) => !savingPrice && setPriceOpen(o)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('detail.price.title')}</DialogTitle>
            <DialogDescription>{t('detail.price.description')}</DialogDescription>
          </DialogHeader>
          <CyclePricingCard
            pricePerSession={pricePerSession}
            extraCosts={extraCosts}
            splitPayment={splitPayment}
            pricesIncludeVat={pricesIncludeVat}
            onPricePerSessionChange={setPricePerSession}
            onExtraCostsChange={setExtraCosts}
            onSplitPaymentChange={setSplitPayment}
            onPricesIncludeVatChange={setPricesIncludeVat}
            academyProfileId={academyProfileId}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)} disabled={savingPrice}>
              {t('detail.price.cancel')}
            </Button>
            <Button onClick={() => void handleSavePrice()} disabled={savingPrice}>
              {savingPrice && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t('detail.price.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit-whole-cycle modal */}
      <Dialog open={editOpen} onOpenChange={(o) => !savingEdit && setEditOpen(o)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('detail.edit.title')}</DialogTitle>
            <DialogDescription>{t('detail.edit.description')}</DialogDescription>
          </DialogHeader>
          {editRepSlot && (
            <SlotEditForm
              key={editEpoch}
              slot={editRepSlot}
              // The form's calendar.* labels live in trainer.json/academy.json (NOT cycles.json) — use
              // 'trainer' (a complete, translated set) so the modal isn't dropped to English defaults.
              namespace="trainer"
              trainers={trainers}
              locations={locations}
              fixedRatingSystem={fixedRatingSystem}
              isSaving={savingEdit}
              onSubmit={(values) => void handleSaveEdit(values)}
              onCancel={() => setEditOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
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
