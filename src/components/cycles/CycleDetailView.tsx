import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CycleStatusBadge } from './CycleStatusBadge';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Users, Trash2, Pencil, CalendarDays, CalendarRange, AlertCircle, Loader2, Save, Euro, UserPlus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { compactDataTableClass } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import CyclePricingCard from '@/components/cycles/CyclePricingCard';
import { CycleEndDateFields, type CycleEndDatePlan } from '@/components/cycles/CycleEndDateFields';
import { SlotEditForm, type SlotEditFormSlot, type SlotEditFormValues } from '@/components/slots/SlotEditForm';
import { supabase } from '@/lib/supabaseClient';
import { useCycleDetail, representativeSlotPrice, type CycleDetailSlot, type CycleRosterEntry } from '@/lib/cycleDetail';
import { pickerExcludeKeysFor, removePersonFromCycle, swapPersonInCycle } from '@/lib/cycleRosterPerson';
import {
  ROSTER_REGISTERED_UNAVAILABLE_I18N,
  admitRosterCandidate,
  isRosterCandidateSelectable,
} from '@/lib/cycleRosterAdmission';
import { addPlayersToCycle, type AddPlayersToCycleResult } from '@/lib/cycleRoster';
import { type BookablePerson } from '@/lib/playersOverview';
import { SkipInvoiceUpdatesCheckbox } from '@/components/booking/SkipInvoiceUpdatesCheckbox';
import { CycleRosterInlinePicker } from '@/components/cycles/CycleRosterInlinePicker';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { UpdateAffectedInvoicesDialog } from '@/components/invoices/UpdateAffectedInvoicesDialog';
import { buildAffectedInvoicesSummary, type AffectedInvoicesSummary } from '@/lib/affectedInvoices';
import { applyAddPlayerInvoiceChoice } from '@/lib/invoiceAfterAddPlayer';
import type { InvoiceUpdateChoice } from '@/lib/invoiceUpdateChoice';
import { paymentStatusBadgeVariant, type CyclusGroupPaymentStatus } from '@/lib/cyclusGroupPayment';
import { cancelBookingsAndDeleteSlots } from '@/lib/slotDeleteGuard';
import { deleteCycle } from '@/lib/cycleWrites';
import { syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';
import { applyCycleEndDate } from '@/lib/cycleExtension';
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
   * inline session-defaults editor, the looptijd editor, the per-session edit/delete actions and the
   * delete-cycle action.
   */
  canEdit?: boolean;
  /** Cycle-pricing capability — gates the inline pricing card. */
  canEditPrice?: boolean;
  /** Academy profile id for the pricing card's extra-cost preset picker (null/omit for trainer). */
  academyProfileId?: string | null;
  /** Trainer options for the session-defaults form (academy passes; trainer omits → self only). */
  trainers?: { id: string; name: string }[];
  /** Location options for the session-defaults form. */
  locations?: { id: string; name: string }[];
  /** Locks the rating picker to the owner's rating system (passed through to SlotEditForm). */
  fixedRatingSystem?: string | null;
  /** Called after a successful cycle-scope mutation, so the wrapper can refetch its own surfaces. */
  onMutated?: () => void;
  /**
   * Called after the WHOLE cycle is deleted (every session removed + cycle row gone). The wrapper
   * navigates away — the cycle no longer exists, so staying on this page would only show "not found".
   * Falls back to `onMutated` when omitted.
   */
  onCycleDeleted?: () => void;
  /**
   * Academy roster surface: enables a per-player "remove from whole cycle" action (with the sticky
   * "Don't update invoices" option) on the roster. Trainer/club omit → roster stays view-only.
   */
  canRemoveFromCycle?: boolean;
  /**
   * Academy roster management: enables "Add players" and per-player "Change"
   * (replace across the whole cycle) on the roster. Trainer/club omit → no
   * add/change. Goes together with `canRemoveFromCycle` for the academy.
   */
  canManageRoster?: boolean;
  /** i18n namespace (default 'cycles' — the neutral home for cycle UI strings). */
  namespace?: string;
}

/**
 * The cycle-detail centerpiece view (Slice 9): open a cycle → see all its sessions + the players in
 * each → drill into one session, OR edit the whole cycle INLINE on the page (no modals). Neutral/shared
 * across academy + trainer (all role differences arrive as props; no cross-role imports). Read-only by
 * itself — the cycle-scope action handlers are injected by the role wrapper.
 *
 * Editing is INLINE (mobile-first stacked cards), each card owning one concern + its own Save button:
 *   - Sessie-instellingen (session defaults) — SlotEditForm with `hidePricing` over the future slots.
 *   - Prijs (price) — CyclePricingCard; price changes ALWAYS resync unpaid invoices.
 *   - Looptijd (end date) — CycleEndDateFields; extend/trim the weekly series.
 *   - Sessions table — per-row Edit (drill in) + Delete (one session) actions.
 *   - A page-level "Don't update invoices" toggle governing the destructive/structural actions.
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
  onCycleDeleted,
  canRemoveFromCycle = false,
  canManageRoster = false,
  namespace = 'cycles',
}: CycleDetailViewProps) {
  const { t, i18n } = useTranslation(namespace);
  const dateLocale = i18n.language?.startsWith('nl') ? nl : enUS;
  const { data, isLoading, isError } = useCycleDetail(cycleId);
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Page-level "Don't update invoices" toggle (checked = SKIP invoice resync). Sticky across the
  // page session; threaded into the roster remove + the cycle delete + the per-session delete.
  const [skipInvoiceUpdates, setSkipInvoiceUpdates] = useState(false);

  // Inline cycle-pricing state (seeded once per cycle from the cycle row; see the seed effect below).
  const [savingPrice, setSavingPrice] = useState(false);
  const [pricePerSession, setPricePerSession] = useState<number | null>(null);
  const [extraCosts, setExtraCosts] = useState<ExtraCost[]>([]);
  const [splitPayment, setSplitPayment] = useState(false);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [pricingSeededFor, setPricingSeededFor] = useState<string | null>(null);

  // Inline looptijd (end-date) state.
  const [savingEndDate, setSavingEndDate] = useState(false);
  const [endDateValue, setEndDateValue] = useState('');
  const [endDatePlan, setEndDatePlan] = useState<CycleEndDatePlan | null>(null);
  const [endDateSeededFor, setEndDateSeededFor] = useState<string | null>(null);

  // Inline session-defaults editor. editRepSlot is the representative future session (a full row
  // fetched when data loads) that seeds the form + the change-detection baseline.
  const [savingEdit, setSavingEdit] = useState(false);
  const [editRepSlot, setEditRepSlot] = useState<SlotEditFormSlot | null>(null);
  // Bumped whenever the rep reloads so the form remounts + re-inits (its init runs once via key).
  const [editEpoch, setEditEpoch] = useState(0);
  // Which (cycle:rep) key we've already loaded — a REF (not state) so updating it doesn't re-run the
  // effect and cancel its own in-flight fetch.
  const editRepLoadedFor = useRef<string | null>(null);
  // Bumped after a successful session-settings save to FORCE the rep baseline to reload from the
  // now-shifted slots — the first-future-slot id is unchanged, so the load effect's deps wouldn't
  // otherwise change, and a second time/duration edit would measure its relative shift off the stale
  // pre-save baseline (landing sessions at the wrong time).
  const [repReloadToken, setRepReloadToken] = useState(0);

  // Per-session delete confirm target + in-flight flag.
  const [deleteSlotTarget, setDeleteSlotTarget] = useState<CycleDetailSlot | null>(null);
  const [deletingSlot, setDeletingSlot] = useState(false);

  // Whole-cycle remove-player (academy roster action).
  const [removeTarget, setRemoveTarget] = useState<CycleRosterEntry | null>(null);
  const [removingFromCycle, setRemovingFromCycle] = useState(false);

  // Whole-cycle add / change-player (academy roster actions) — inline, like the slot page. The
  // selection is a full BookablePerson (guest OR registered) so a registered pick can be resolved
  // to its guest twin at confirm time (person-unification Phase 0).
  const [addPanelOpen, setAddPanelOpen] = useState(false);
  const [addSelectedPerson, setAddSelectedPerson] = useState<BookablePerson | null>(null);
  // Which roster row is expanded for inline edit (change / remove), keyed by its stable id.
  const [expandedRosterKey, setExpandedRosterKey] = useState<string | null>(null);
  const [changeSelectedPerson, setChangeSelectedPerson] = useState<BookablePerson | null>(null);
  const [rosterBusy, setRosterBusy] = useState(false);
  // Sent/paid-invoice confirmation after an add/change that touched invoices.
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [invoiceSummary, setInvoiceSummary] = useState<AffectedInvoicesSummary | null>(null);
  const [pendingInvoiceSlotIds, setPendingInvoiceSlotIds] = useState<string[]>([]);
  const [invoiceApplying, setInvoiceApplying] = useState(false);

  // Future (not-yet-started) sessions are the whole-cycle edit/delete scope (matches the slot-detail
  // "future only" rule). The delete RPC keeps any still-booked session; the edit RPC keeps any slot
  // it would have to shrink below its occupancy.
  const futureSlotIds = useMemo(
    () => (data?.slots ?? []).filter((s) => new Date(s.start_time).getTime() >= Date.now()).map((s) => s.id),
    [data],
  );
  // Roster add/change/remove apply to EVERY session of the cycle (past + future) so a wrong
  // planning can be fully corrected — the owner's chosen scope for these actions.
  const allSlotIds = useMemo(() => (data?.slots ?? []).map((s) => s.id), [data]);

  const cycle = data?.cycle ?? null;
  const slots = useMemo(() => data?.slots ?? [], [data]);

  // Seed the inline pricing card from the SLOTS' actual price (the booking-truth value), falling back
  // to the cycle row only when no slot carries a price. cycles.price_per_session can drift from the
  // slots (bulk-copy attach, rebook, a misrouted edit) — seeding from it meant opening + saving the
  // card pushed the STALE cycle value back over the real slot prices and re-invoiced at it (audit
  // Batch 2 a). Guarded (once per cycle id) so re-renders never clobber an in-progress edit.
  useEffect(() => {
    if (!cycle || pricingSeededFor === cycle.id) return;
    setPricePerSession(representativeSlotPrice(slots) ?? cycle.price_per_session ?? null);
    setExtraCosts((cycle.settings?.extra_costs as ExtraCost[] | undefined) ?? []);
    setSplitPayment(cycle.settings?.split_payment ?? false);
    setPricesIncludeVat(cycle.settings?.prices_include_vat ?? true);
    setPricingSeededFor(cycle.id);
  }, [cycle, slots, pricingSeededFor]);

  // Seed the inline looptijd value once per cycle (start = cycle start_date or first session date;
  // originalEnd = cycle end_date).
  const cycleStartDate = useMemo(
    () => (cycle?.start_date ?? slots[0]?.start_time?.slice(0, 10) ?? null),
    [cycle, slots],
  );
  useEffect(() => {
    if (!cycle || endDateSeededFor === cycle.id) return;
    setEndDateValue(cycle.end_date ?? '');
    setEndDateSeededFor(cycle.id);
  }, [cycle, endDateSeededFor]);

  // Load the representative future session for the inline session-defaults form when data loads / the
  // future scope changes. Fetches the same full row the old modal did. No future slots → no rep (the
  // card shows a "no future sessions" note instead).
  const firstFutureSlotId = futureSlotIds[0] ?? null;
  useEffect(() => {
    if (!canEdit) return;
    const key = `${cycleId}:${firstFutureSlotId ?? 'none'}`;
    if (editRepLoadedFor.current === key) return;
    editRepLoadedFor.current = key;
    if (!firstFutureSlotId) {
      setEditRepSlot(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data: row, error } = await supabase
          .from('availability_slots')
          .select(
            'start_time, end_time, trainer_id, location_id, max_participants, rating_system, min_rating, max_rating, cyclus_id, cyclus_name, is_public, price_per_session, total_price, split_payment, prices_include_vat, extra_costs',
          )
          .eq('id', firstFutureSlotId)
          .maybeSingle();
        if (cancelled) return;
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
      } catch (err) {
        if (!cancelled) {
          setEditRepSlot(null);
          toast.error(getFriendlyErrorMessage(err, t('detail.edit.loadError')));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, cycleId, firstFutureSlotId, repReloadToken]);

  if (isLoading) return <CycleDetailSkeleton />;
  if (isError || !data) {
    return <StateCard icon={<AlertCircle className="h-5 w-5 text-destructive" />} message={t('detail.loadError')} />;
  }

  const { roster, totalSlots, totalPlayers } = data;
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
      // FULL cycle delete: cancel EVERY active booking across ALL sessions (past + future), delete all
      // sessions, then remove the cycle row so it disappears from the list. `cancelBookingsAndDeleteSlots`
      // cancels the exact CAPACITY_OCCUPYING set the RPC protects, then the RPC deletes the now-empty
      // slots and resyncs split counts — all honouring the page-level "Don't update invoices" toggle.
      // Pass cycleId only for a real cycle row (orphan groups have no row → null, like the table view).
      const hasCycleRow = !!cycle;
      const res = await cancelBookingsAndDeleteSlots(
        hasCycleRow ? cycleId : null,
        allSlotIds,
        { skipInvoices: skipInvoiceUpdates },
      );
      if (res.syncError) logger.error('Invoice resync failed after full cycle delete', res.syncError);
      // Only remove the cycle row once every session is actually gone. If a booking raced in during the
      // delete (protectedCount > 0) some sessions survive — keep the row so they don't become orphans.
      const fullyCleared = res.protectedCount === 0;
      if (hasCycleRow && fullyCleared) {
        try {
          await deleteCycle(cycleId);
        } catch (e) {
          logger.error('Failed to delete cycle row after clearing its sessions', e as Error);
        }
      }
      // Close first so the (now-disabled) confirm can't be re-fired and any parent refetch/navigation
      // happens with the dialog already dismissed.
      setDeleteOpen(false);
      if (fullyCleared) {
        toast.success(t('detail.delete.deleted', { sessions: res.deletedCount, bookings: res.cancelledBookings }));
        void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
        // The cycle is gone — leave the page. Falls back to a refetch when no navigation is wired.
        if (onCycleDeleted) onCycleDeleted();
        else onMutated?.();
      } else {
        // Rare race: a new booking landed mid-delete. We cancelled + removed what we could; report it
        // and stay on the page so the owner can retry.
        toast(t('detail.delete.partial', { kept: res.protectedCount }));
        void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
        onMutated?.();
      }
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.delete.error')));
    } finally {
      setDeleting(false);
    }
  };

  // Delete ONE session. Cancels any bookings on it first (honouring the page toggle), then deletes
  // it: an empty session is just removed; a booked one has its bookings cancelled + the session
  // removed. The cancel→delete→split-resync runs inside cancelBookingsAndDeleteSlots.
  const handleDeleteSlot = async () => {
    if (!deleteSlotTarget) return;
    setDeletingSlot(true);
    try {
      const res = await cancelBookingsAndDeleteSlots(cycleId, [deleteSlotTarget.id], { skipInvoices: skipInvoiceUpdates });
      if (res.deletedCount === 0) {
        toast.error(t('detail.deleteSlot.error', 'Could not delete the session. Please try again.'));
        setDeleteSlotTarget(null);
        return;
      }
      if (res.syncError) logger.error('Invoice resync failed after session delete', res.syncError);
      setDeleteSlotTarget(null);
      toast.success(t('detail.deleteSlot.deleted', 'Session deleted'));
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.deleteSlot.error', 'Could not delete the session. Please try again.')));
    } finally {
      setDeletingSlot(false);
    }
  };

  // Remove one player from the whole series (EVERY session, past + future), honouring the sticky
  // "Don't update invoices" toggle. Bookings are soft-cancelled via the canonical facade; paid
  // invoices are protected regardless (the lib skips them).
  const handleRemoveFromCycle = async () => {
    if (!removeTarget) return;
    setRemovingFromCycle(true);
    try {
      if (allSlotIds.length === 0) {
        toast(t('detail.roster.removeFromCycleNone'));
        setRemoveTarget(null);
        return;
      }
      // Phase 3.1: a merged person's roster entry spans EVERY old-world ref they hold seats
      // under — removePersonFromCycle covers all of them or half the person stays silently seated.
      const res = await removePersonFromCycle(allSlotIds, removeTarget, supabase, {
        skipInvoiceSync: skipInvoiceUpdates,
        declineClaims: true,
      });
      if (res.syncError) logger.error('Invoice sync after whole-cycle remove failed', res.syncError as Error);
      setRemoveTarget(null);
      toast.success(t('detail.roster.removedFromCycle', { count: res.cancelledCount }));
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.roster.removeFromCycleError')));
    } finally {
      setRemovingFromCycle(false);
    }
  };

  // Shared after-add/change handling: surface "some sessions skipped" info, then either open the
  // sent/paid-invoice confirmation (only when invoices were updated AND sent/paid ones are affected)
  // or just refetch. Returns true when the invoice dialog took over (caller must not refetch yet).
  const handleRosterAddResult = (res: AddPlayersToCycleResult): boolean => {
    if (res.blockedSlotIds.length > 0) {
      toast(t('detail.roster.addBlocked', { count: res.blockedSlotIds.length }));
    }
    if (res.rebalanceFailed) {
      toast.error(t('detail.roster.rebalanceFailed'));
    }
    if (res.invoiceResult?.needsConfirmation && !skipInvoiceUpdates) {
      setPendingInvoiceSlotIds(res.affectedSlotIds);
      setInvoiceSummary(buildAffectedInvoicesSummary(res.invoiceResult.classification));
      setInvoiceDialogOpen(true);
      return true;
    }
    return false;
  };

  // Pass B §4: admission is decided PURELY, before any network activity.
  //
  // A directly owned guest is itself. A REGISTERED player is refused here and no longer minted a
  // "guest twin" — that twin was created from a name/email match against the account, which is
  // the identity evidence this containment withdrew, and a twin minted for the wrong human seats
  // AND BILLS the wrong human. The retired resolver is not called on this path at all, so there
  // is no request to fail and nothing optimistic to roll back.
  //
  // FAM-02: a row carrying a guest id IS that guest; an accompanying profile id is decoration and
  // is not passed on as a twin hint.
  const resolvePersonToGuest = (
    person: BookablePerson,
  ): { guestPlayerId: string; twinProfileId: string | null } | null => {
    const decision = admitRosterCandidate({
      guestPlayerId: person.guestPlayerId ?? null,
      profileId: person.profileId ?? null,
    });
    return decision.admitted
      ? { guestPlayerId: decision.guestPlayerId, twinProfileId: null }
      : null;
  };

  // Add one player to EVERY session of the cycle (skips sessions where they're already booked or
  // that are full). Honours the sticky "Don't update invoices" toggle.
  const handleAddPlayer = async (person: BookablePerson) => {
    // Refused BEFORE the busy flag and before any request: an unavailable action must not look
    // like one that was attempted and failed.
    const resolved = resolvePersonToGuest(person);
    if (!resolved) {
      toast.error(t(ROSTER_REGISTERED_UNAVAILABLE_I18N.key, ROSTER_REGISTERED_UNAVAILABLE_I18N.default));
      return;
    }
    setRosterBusy(true);
    try {
      const res = await addPlayersToCycle({
        cycleId,
        guestPlayerIds: [resolved.guestPlayerId],
        twinProfileIdByGuestId: resolved.twinProfileId
          ? { [resolved.guestPlayerId]: resolved.twinProfileId }
          : undefined,
        skipInvoices: skipInvoiceUpdates,
      });
      setAddPanelOpen(false);
      setAddSelectedPerson(null);
      if (res.insertedCount === 0) {
        toast(t('detail.roster.addNone'));
      } else {
        toast.success(t('detail.roster.added', { count: res.insertedCount }));
      }
      const deferred = handleRosterAddResult(res);
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      if (!deferred) onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.roster.addError')));
    } finally {
      setRosterBusy(false);
    }
  };

  // Replace one enrolled player with another across EVERY session by re-pointing the outgoing
  // player's bookings to the incoming guest IN PLACE (keeps amount/paid state — no €0 sessions, no
  // orphaned draft). Invoices reconcile only when the sticky toggle is off.
  const handleSwapPlayer = async (entry: CycleRosterEntry, person: BookablePerson) => {
    // Same rule as add, and refused just as early: no busy state, no request, no partial swap.
    const resolved = resolvePersonToGuest(person);
    if (!resolved) {
      toast.error(t(ROSTER_REGISTERED_UNAVAILABLE_I18N.key, ROSTER_REGISTERED_UNAVAILABLE_I18N.default));
      return;
    }
    setRosterBusy(true);
    try {
      // Phase 3.1: swap out EVERY old-world ref the outgoing person holds seats under (one swap
      // per ref, same incoming person; duplicate seats resolve via swap's collision handling).
      const res = await swapPersonInCycle({
        cycleId,
        fromEntry: entry,
        toGuestPlayerId: resolved.guestPlayerId,
        toProfileId: resolved.twinProfileId,
        skipInvoices: skipInvoiceUpdates,
      });
      setExpandedRosterKey(null);
      setChangeSelectedPerson(null);
      if (res.reassignedCount + res.cancelledCollisionCount === 0) {
        toast(t('detail.roster.changeNone'));
      } else {
        toast.success(t('detail.roster.changed', { count: res.reassignedCount }));
        if (res.syncFailed) toast.error(t('detail.roster.changeSyncFailed'));
      }
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.roster.changeError')));
    } finally {
      setRosterBusy(false);
    }
  };

  const handleInvoiceChoice = async (choice: InvoiceUpdateChoice) => {
    setInvoiceApplying(true);
    try {
      if (choice !== 'skip' && pendingInvoiceSlotIds.length > 0) {
        await applyAddPlayerInvoiceChoice(pendingInvoiceSlotIds, choice);
      }
    } catch (err) {
      logger.error('Failed to apply invoice update choice after roster add/change', err as Error);
    } finally {
      setInvoiceApplying(false);
      setInvoiceDialogOpen(false);
      setPendingInvoiceSlotIds([]);
      setInvoiceSummary(null);
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    }
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
      // affected (unpaid) invoice line items. Price ALWAYS updates invoices (NOT gated on the toggle —
      // a stale invoice amount is a billing error, not a roster convenience). Non-fatal: price saved.
      try {
        await syncInvoicesAfterPriceChange(slots.map((s) => s.id));
      } catch (e) {
        logger.error('Failed to sync invoices after cycle price change', e as Error);
      }
      toast.success(t('detail.price.saved'));
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.price.error')));
    } finally {
      setSavingPrice(false);
    }
  };

  const handleSaveEndDate = async () => {
    if (!endDateValue || endDatePlan?.invalid) return;
    setSavingEndDate(true);
    try {
      const { added, removed } = await applyCycleEndDate(cycleId, endDatePlan?.endDate ?? endDateValue, {
        removableIds: endDatePlan?.removableIds,
        removeUnbooked: endDatePlan?.removeUnbooked,
        // Only when the owner explicitly opted in to dropping the booked out-of-range sessions.
        bookedIdsToRemove: endDatePlan?.removeBooked ? endDatePlan?.protectedIds : undefined,
        skipInvoices: skipInvoiceUpdates,
        newSessionStatus: endDatePlan?.newSessionStatus,
      });
      if (added > 0) toast.success(t('detail.edit.sessionsAdded', { count: added }));
      else if (removed > 0) toast.success(t('detail.edit.sessionsRemoved', { count: removed }));
      else toast.success(t('detail.edit.endDateUpdated'));
      void queryClient.invalidateQueries({ queryKey: ['cycle-detail', cycleId] });
      onMutated?.();
    } catch (err) {
      toast.error(getFriendlyErrorMessage(err, t('detail.edit.error')));
    } finally {
      setSavingEndDate(false);
    }
  };

  const handleSaveEdit = async (values: SlotEditFormValues) => {
    if (!editRepSlot || savingEdit) return; // guard against a fast double-submit
    // Diff against the representative slot → only changed fields go in the patch (omitted keys are
    // kept per-slot, so a time-only edit can't reshape another session). See cycleEditPatch.ts.
    const patch = buildCycleEditPatch(values, slotEditBaselineFromSlot(editRepSlot));
    if (Object.keys(patch).length === 0) {
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
      // The capacity guard is all-or-nothing, so updatedCount XOR blockedCount. A blocked result means
      // NOTHING changed → surface it as an error, not a benign toast.
      if (res.updatedCount > 0) toast.success(message);
      else if (res.blockedCount > 0) toast.error(message);
      else toast(message);
      // The sessions just shifted but the first-future-slot id didn't change — force the rep baseline
      // to reload so a SECOND time/duration edit measures its shift off the NEW times, not the stale ones.
      if (res.updatedCount > 0) {
        editRepLoadedFor.current = '';
        setRepReloadToken((n) => n + 1);
      }
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

  const endDateInvalid = endDatePlan?.invalid ?? false;

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold truncate">{title}</h1>
              {statusKey && <CycleStatusBadge status={statusKey} />}
            </div>
            <p className="text-sm text-muted-foreground">
              {fmtPeriod(periodStart)} → {fmtPeriod(periodEnd, true)}
              {locationName && <> · {locationName}</>}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('detail.summary', { players: totalPlayers, sessions: totalSlots })}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Page-level "Don't update invoices" toggle — governs the structural/destructive actions
          (cycle delete + per-session delete + roster remove). Price changes always update invoices. */}
      {(canEdit || canRemoveFromCycle) && (
        <SkipInvoiceUpdatesCheckbox
          checked={skipInvoiceUpdates}
          onCheckedChange={setSkipInvoiceUpdates}
          id="cycle-skip-invoice-updates"
        />
      )}

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
              {/* Desktop table — escape hatch: compact 40px density on the existing sessions table
                  (already inside this Card, so no DataTableCard). overflow-x-auto handles the min-width. */}
              <div className="hidden md:block overflow-x-auto">
                <Table className={compactDataTableClass}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('detail.sessions.when')}</TableHead>
                      <TableHead className="text-center">{t('detail.sessions.occupancy')}</TableHead>
                      <TableHead>{t('detail.sessions.players')}</TableHead>
                      <TableHead>{t('detail.sessions.payment')}</TableHead>
                      {canEdit && <TableHead className="text-right">{t('detail.sessions.actions', 'Actions')}</TableHead>}
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
                        {canEdit && (
                          <TableCell className="text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('detail.sessions.editSession', 'Edit session')}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenSlot(slot.id);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('detail.sessions.deleteSession', 'Delete session')}
                                className="text-destructive hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteSlotTarget(slot);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile list */}
              <div className="md:hidden divide-y">
                {slots.map((slot) => (
                  <div key={slot.id} className="flex items-stretch">
                    <button
                      type="button"
                      aria-label={fmtDayTime(slot)}
                      onClick={() => onOpenSlot(slot.id)}
                      className="flex-1 min-w-0 text-left p-3 space-y-1.5 hover:bg-muted/50"
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
                    {canEdit && (
                      <div className="flex flex-col items-center justify-center gap-1 pr-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('detail.sessions.editSession', 'Edit session')}
                          onClick={() => onOpenSlot(slot.id)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('detail.sessions.deleteSession', 'Delete session')}
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteSlotTarget(slot)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Roster */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" />
              {t('detail.roster.title')}
            </CardTitle>
            {canManageRoster && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                disabled={rosterBusy}
                onClick={() => { setAddPanelOpen((o) => !o); setAddSelectedPerson(null); }}
              >
                <UserPlus className="h-3.5 w-3.5" />
                {t('detail.roster.addPlayer')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {roster.length === 0 && !addPanelOpen ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('detail.roster.empty')}</p>
          ) : (
            <div className="space-y-1">
              {roster.map((p, i) => {
                const rowKey = p.personId ?? p.guestPlayerId ?? p.playerId ?? `${p.name}-${i}`;
                const expanded = expandedRosterKey === rowKey;
                // Registered (player_id) rows are now changeable too (person-unification Phase 0):
                // the row carries a person ref the swap scopes correctly.
                const canChange = canManageRoster && (!!p.guestPlayerId || !!p.playerId);
                // Exclude EVERY picker row of this person (a merged human has both a g_ and a p_
                // row until the 3.2 picker dedup) — not just the primary ref's side.
                const excludeKeys = pickerExcludeKeysFor(p);
                const interactive = canChange || canRemoveFromCycle;
                return (
                  <div key={rowKey}>
                    <button
                      type="button"
                      disabled={!interactive}
                      className="w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors enabled:hover:bg-accent/50 disabled:cursor-default"
                      onClick={() => { setExpandedRosterKey(expanded ? null : rowKey); setChangeSelectedPerson(null); }}
                    >
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-[10px]">{p.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{t('detail.roster.sessionCount', { count: p.sessionCount })}</p>
                      </div>
                      {/* Phase 3.3a: badge the HUMAN's account status, not the seat's key — a
                          merged person's seats are guest-keyed by design (FAM-02). */}
                      {!p.hasLogin && (
                        <Badge variant="outline" className="text-[10px] h-5 px-1.5">{t('detail.roster.guest', 'Guest')}</Badge>
                      )}
                      {interactive && <Pencil className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    </button>

                    {expanded && interactive && (
                      <div className="mt-1 mb-2 ml-11 mr-1 rounded-lg border bg-muted/30 p-3 space-y-3">
                        {canChange && (
                          <div className="space-y-1.5">
                            <p className="text-xs font-medium text-muted-foreground">{t('detail.roster.changeDescription')}</p>
                            <div className="flex items-center gap-2">
                              <CycleRosterInlinePicker
                                academyProfileId={academyProfileId}
                                value={changeSelectedPerson?.comboboxId ?? ''}
                                onSelect={setChangeSelectedPerson}
                                excludePersonKeys={excludeKeys}
                                excludePersonIds={p.personId ? [p.personId] : []}
                                disabled={rosterBusy}
                                namespace={namespace}
                              />
                              <Button
                                size="sm"
                                className="shrink-0"
                                data-testid="cycle-roster-change-confirm"
                                data-admits-selection={String(isRosterCandidateSelectable(changeSelectedPerson))}
                                disabled={
                                  !changeSelectedPerson ||
                                  rosterBusy ||
                                  !isRosterCandidateSelectable(changeSelectedPerson)
                                }
                                title={
                                  changeSelectedPerson && !isRosterCandidateSelectable(changeSelectedPerson)
                                    ? t(
                                        ROSTER_REGISTERED_UNAVAILABLE_I18N.key,
                                        ROSTER_REGISTERED_UNAVAILABLE_I18N.default,
                                      )
                                    : undefined
                                }
                                onClick={() => changeSelectedPerson && void handleSwapPlayer(p, changeSelectedPerson)}
                              >
                                {rosterBusy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                                {t('detail.roster.changeConfirm')}
                              </Button>
                              {changeSelectedPerson && !isRosterCandidateSelectable(changeSelectedPerson) && (
                                <p
                                  className="text-xs text-muted-foreground"
                                  data-testid="cycle-roster-swap-unavailable"
                                  role="note"
                                >
                                  {/* A title attribute alone is invisible to keyboard and screen
                                      reader users and never appears on touch. The reason is
                                      rendered. */}
                                  {t(
                                    ROSTER_REGISTERED_UNAVAILABLE_I18N.key,
                                    ROSTER_REGISTERED_UNAVAILABLE_I18N.default,
                                  )}
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        <SkipInvoiceUpdatesCheckbox
                          checked={skipInvoiceUpdates}
                          onCheckedChange={setSkipInvoiceUpdates}
                          disabled={rosterBusy}
                        />

                        {canRemoveFromCycle && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={rosterBusy}
                            onClick={() => setRemoveTarget(p)}
                          >
                            <Trash2 className="h-4 w-4 mr-1.5" />
                            {t('detail.roster.removeFromCycle')}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {canManageRoster && addPanelOpen && (
                <div className="mt-2 rounded-lg border bg-muted/30 p-3 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('detail.roster.addDescription')}</p>
                  <CycleRosterInlinePicker
                    academyProfileId={academyProfileId}
                    value={addSelectedPerson?.comboboxId ?? ''}
                    onSelect={setAddSelectedPerson}
                    disabled={rosterBusy}
                    namespace={namespace}
                  />
                  <SkipInvoiceUpdatesCheckbox
                    checked={skipInvoiceUpdates}
                    onCheckedChange={setSkipInvoiceUpdates}
                    disabled={rosterBusy}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      data-testid="cycle-roster-add-confirm"
                      data-admits-selection={String(isRosterCandidateSelectable(addSelectedPerson))}
                      disabled={
                        !addSelectedPerson || rosterBusy || !isRosterCandidateSelectable(addSelectedPerson)
                      }
                      title={
                        addSelectedPerson && !isRosterCandidateSelectable(addSelectedPerson)
                          ? t(
                              ROSTER_REGISTERED_UNAVAILABLE_I18N.key,
                              ROSTER_REGISTERED_UNAVAILABLE_I18N.default,
                            )
                          : undefined
                      }
                      onClick={() => addSelectedPerson && void handleAddPlayer(addSelectedPerson)}
                    >
                      {rosterBusy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                      {t('detail.roster.addConfirm')}
                    </Button>
                    {addSelectedPerson && !isRosterCandidateSelectable(addSelectedPerson) && (
                      <p
                        className="text-xs text-muted-foreground self-center"
                        data-testid="cycle-roster-registered-unavailable"
                      >
                        {t(
                          ROSTER_REGISTERED_UNAVAILABLE_I18N.key,
                          ROSTER_REGISTERED_UNAVAILABLE_I18N.default,
                        )}
                      </p>
                    )}
                    <Button size="sm" variant="ghost" disabled={rosterBusy} onClick={() => { setAddPanelOpen(false); setAddSelectedPerson(null); }}>
                      {t('detail.delete.cancel')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inline cycle settings (session defaults + price + looptijd), gated like the old toolbar. */}
      {canEditPrice && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Euro className="h-4 w-4" />
              {t('detail.price.title')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('detail.price.description')}</p>
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
            <div className="flex">
              <Button size="sm" onClick={() => void handleSavePrice()} disabled={savingPrice} className="gap-1.5">
                {savingPrice ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t('detail.price.save')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarRange className="h-4 w-4" />
              {t('detail.editEndDate', 'Looptijd')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <CycleEndDateFields
              cyclusId={cycleId}
              open
              startDate={cycleStartDate}
              originalEnd={cycle?.end_date ?? null}
              value={endDateValue}
              onChange={setEndDateValue}
              onPlanChange={setEndDatePlan}
              disabled={savingEndDate}
              allowRemoveBooked={canEdit}
              namespace={namespace}
            />
            <div className="flex">
              <Button
                size="sm"
                onClick={() => void handleSaveEndDate()}
                disabled={savingEndDate || !endDateValue || endDateInvalid}
                className="gap-1.5"
              >
                {savingEndDate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t('editEndDate.save', 'Opslaan')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Pencil className="h-4 w-4" />
              {t('detail.settings.title', 'Session settings')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">{t('detail.edit.description')}</p>
            {editRepSlot ? (
              <SlotEditForm
                key={editEpoch}
                slot={editRepSlot}
                hidePricing
                // The form's calendar.* labels live in trainer.json/academy.json (NOT cycles.json) — use
                // 'trainer' (a complete, translated set) so the form isn't dropped to English defaults.
                namespace="trainer"
                trainers={trainers}
                locations={locations}
                fixedRatingSystem={fixedRatingSystem}
                isSaving={savingEdit}
                onSubmit={(values) => void handleSaveEdit(values)}
                onCancel={() => setEditEpoch((e) => e + 1)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('detail.edit.noFuture')}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Danger zone: FULL cycle delete — cancels every booking + removes all sessions + the cycle. */}
      {canEdit && (
        <Card className="border-destructive/30">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="text-sm">
              <p className="font-medium">{t('detail.deleteCycle')}</p>
              <p className="text-muted-foreground">{t('detail.deleteCycleHint')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              className="text-destructive hover:text-destructive shrink-0"
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              {t('detail.deleteCycle')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Whole-cycle remove-player confirmation (academy roster action) */}
      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !removingFromCycle && !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.roster.removeFromCycleConfirm', { name: removeTarget?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('detail.roster.removeFromCycleDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {/* The "Don't update invoices" choice is the single page-level toggle above (sticky for the
              whole page) — no per-dialog duplicate. */}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removingFromCycle}>
              {t('detail.delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleRemoveFromCycle()} disabled={removingFromCycle}>
              {removingFromCycle && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t('detail.roster.removeFromCycle')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sent/paid-invoice confirmation after a roster add/change that updated invoices */}
      {invoiceSummary && (
        <UpdateAffectedInvoicesDialog
          open={invoiceDialogOpen}
          onOpenChange={(o) => {
            // Dismissing without a choice = leave sent/paid invoices as they are ("skip").
            if (!o && !invoiceApplying) void handleInvoiceChoice('skip');
          }}
          summary={invoiceSummary}
          loading={invoiceApplying}
          onConfirm={(choice) => void handleInvoiceChoice(choice)}
        />
      )}

      {/* Per-session delete confirmation */}
      <AlertDialog open={!!deleteSlotTarget} onOpenChange={(o) => !deletingSlot && !o && setDeleteSlotTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.deleteSlot.confirmTitle', 'Delete this session?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSlotTarget && deleteSlotTarget.bookedCount > 0
                ? t('detail.deleteSlot.confirmBodyBooked', 'This session has {{count}} booking(s). They will be cancelled and the session removed.', { count: deleteSlotTarget.bookedCount })
                : t('detail.deleteSlot.confirmBodyEmpty', 'This removes the session.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteSlotTarget && deleteSlotTarget.bookedCount > 0 && (
            <SkipInvoiceUpdatesCheckbox
              checked={skipInvoiceUpdates}
              onCheckedChange={setSkipInvoiceUpdates}
              disabled={deletingSlot}
            />
          )}
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteSlotTarget(null)} disabled={deletingSlot}>
              {t('detail.delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteSlot()} disabled={deletingSlot}>
              {deletingSlot && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t('detail.delete.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* FULL cycle delete confirmation — strong warning: this cancels every booking and cannot be undone. */}
      <AlertDialog open={deleteOpen} onOpenChange={(o) => !deleting && setDeleteOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detail.delete.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {totalPlayers > 0
                ? t('detail.delete.confirmBodyBooked', { sessions: totalSlots, players: totalPlayers })
                : t('detail.delete.confirmBodyEmpty', { sessions: totalSlots })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm font-medium text-destructive">
            {t('detail.delete.irreversible')}
          </div>
          {totalPlayers > 0 && (
            <SkipInvoiceUpdatesCheckbox
              checked={skipInvoiceUpdates}
              onCheckedChange={setSkipInvoiceUpdates}
              disabled={deleting}
            />
          )}
          <Separator />
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t('detail.delete.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteCycle()} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {t('detail.delete.confirmCycle')}
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
