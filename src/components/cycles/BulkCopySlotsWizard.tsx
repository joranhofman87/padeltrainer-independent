import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { differenceInCalendarWeeks } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DateInputField } from '@/components/ui/date-input-field';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { ArrowLeft, Copy, ChevronDown, Send } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatCurrency, formatDate } from '@/lib/format';
import { getCycles, getCycle, createCycle, updateCycleSettings, type Cycle } from '@/lib/cycles';
import { fetchCyclusLabels, buildCyclusLabel, type CyclusRosterEntry } from '@/lib/cyclusLabel';
import { bulkCopySlotsToCycle, getBookingsBySlotIds, notifyPriorityClaimsForSlots, type RebookPaymentMode } from '@/lib/priorityClaims';

interface Props {
  ownerType: 'trainer' | 'club' | 'academy';
  ownerId: string;
  backHref: string;
}

interface SourceSlot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_name: string | null;
  max_participants: number | null;
  price_per_session: number | null;
}

export default function BulkCopySlotsWizard({ ownerType, ownerId, backHref }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cyclusLabels, setCyclusLabels] = useState<Map<string, CyclusRosterEntry>>(new Map());
  const [loadingCycles, setLoadingCycles] = useState(true);
  const [sourceCycleId, setSourceCycleId] = useState<string>(searchParams.get('source') ?? '');
  const [targetMode, setTargetMode] = useState<'new' | 'existing'>('new');
  const [targetCycleId, setTargetCycleId] = useState<string>('');
  const [newCycleName, setNewCycleName] = useState<string>('');
  const [newCycleStart, setNewCycleStart] = useState<string>('');
  const [sourceSlots, setSourceSlots] = useState<SourceSlot[]>([]);
  const [excludeSlotIds, setExcludeSlotIds] = useState<Set<string>>(new Set());
  const [bookingCounts, setBookingCounts] = useState<Map<string, number>>(new Map());
  const [priorityWindowDays, setPriorityWindowDays] = useState(14);
  const [createPriorityClaims, setCreatePriorityClaims] = useState(true);
  const [rebookPaymentMode, setRebookPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [notifyPlayers, setNotifyPlayers] = useState(true);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getCycles(ownerType, ownerId)
      .then((c) => setCycles(c))
      .catch((e) => toast.error(getFriendlyErrorMessage(e, t('bulkCopy.errLoadCycles', 'Could not load your cycles. Please try again.'))))
      .finally(() => setLoadingCycles(false));
  }, [ownerType, ownerId, t]);

  // Enrich the dropdown labels with each cyclus's day/time + roster + location
  // (one RPC; falls back to cycle.name on error / non-academy / pre-migration).
  useEffect(() => {
    fetchCyclusLabels(ownerType, ownerId).then(setCyclusLabels);
  }, [ownerType, ownerId]);

  const cyclusLabel = (c: Cycle): string => buildCyclusLabel(cyclusLabels.get(c.id)) ?? c.name;

  useEffect(() => {
    if (!sourceCycleId) {
      setSourceSlots([]);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('availability_slots')
        .select('id, start_time, end_time, cyclus_name, max_participants, price_per_session')
        .eq('cyclus_id', sourceCycleId)
        .order('start_time');
      if (error) {
        toast.error(getFriendlyErrorMessage(error, t('bulkCopy.errLoadSlots', 'Could not load the trainings for this cycle. Please try again.')));
        return;
      }
      setSourceSlots(data || []);
      const map = await getBookingsBySlotIds((data || []).map((s) => s.id));
      const counts = new Map<string, number>();
      map.forEach((arr, k) => counts.set(k, arr.length));
      setBookingCounts(counts);
    })();
  }, [sourceCycleId, t]);

  const sourceCycle = useMemo(
    () => cycles.find((c) => c.id === sourceCycleId) ?? null,
    [cycles, sourceCycleId],
  );

  // Suggest a name for the new cycle once a source is chosen.
  useEffect(() => {
    if (sourceCycle && !newCycleName) {
      setNewCycleName(`${sourceCycle.name} ${t('bulkCopy.nextRoundSuffix', '(next round)')}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCycle?.id]);

  const weeksOffset = useMemo(() => {
    const src = sourceCycle;
    const targetStart =
      targetMode === 'new'
        ? (newCycleStart || null)
        : (cycles.find((c) => c.id === targetCycleId)?.start_date ?? null);
    if (!src?.start_date || !targetStart) return 0;
    return differenceInCalendarWeeks(new Date(targetStart), new Date(src.start_date));
  }, [sourceCycle, cycles, targetCycleId, targetMode, newCycleStart]);

  const toggleExclude = (id: string) => {
    setExcludeSlotIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!sourceCycleId) {
      toast.error(t('bulkCopy.errSelectSource', 'Choose a cycle to copy from first'));
      return;
    }
    if (targetMode === 'new' && !newCycleStart) {
      toast.error(t('bulkCopy.errSelectStart', 'Choose a start date for the new cycle'));
      return;
    }
    if (targetMode === 'existing' && (!targetCycleId || targetCycleId === sourceCycleId)) {
      toast.error(t('bulkCopy.errSelectTarget', 'Choose a different target cycle'));
      return;
    }
    setSubmitting(true);
    try {
      // Create the target cycle inline when requested, carrying the source
      // cycle's settings/pricing and keeping the same length.
      let effectiveTargetId = targetCycleId;
      if (targetMode === 'new') {
        if (!sourceCycle) {
          toast.error(t('bulkCopy.errSourceNotFound', 'Source cycle not found'));
          setSubmitting(false);
          return;
        }
        let endDate: string | null = null;
        if (sourceCycle.start_date && sourceCycle.end_date) {
          const durationMs = new Date(sourceCycle.end_date).getTime() - new Date(sourceCycle.start_date).getTime();
          endDate = new Date(new Date(newCycleStart).getTime() + Math.max(0, durationMs)).toISOString().slice(0, 10);
        }
        const created = await createCycle({
          owner_type: ownerType,
          owner_id: ownerId,
          name: newCycleName.trim() || `${sourceCycle.name} ${t('bulkCopy.nextRoundSuffix', '(next round)')}`,
          description: sourceCycle.description ?? undefined,
          start_date: newCycleStart,
          end_date: endDate,
          settings: { ...sourceCycle.settings, rebook_payment_mode: rebookPaymentMode },
          status: 'open',
          type: sourceCycle.type,
          location_id: sourceCycle.location_id,
          price_per_session: sourceCycle.price_per_session,
          total_price: sourceCycle.total_price,
          currency: sourceCycle.currency,
          terms: sourceCycle.terms,
          price_table: sourceCycle.price_table,
        });
        effectiveTargetId = created.id;
      } else if (createPriorityClaims) {
        // Existing target cycle: persist the chosen payment mode on its
        // settings (read-modify-write so other settings keys are preserved).
        // Must happen BEFORE the invitation emails read the cycle settings.
        const targetCycle = await getCycle(effectiveTargetId);
        await updateCycleSettings(effectiveTargetId, {
          ...(targetCycle?.settings ?? {}),
          rebook_payment_mode: rebookPaymentMode,
        });
      }

      const result = await bulkCopySlotsToCycle({
        sourceCycleId,
        targetCycleId: effectiveTargetId,
        weeksOffset,
        priorityWindowDays,
        createPriorityClaims,
        excludeSourceSlotIds: Array.from(excludeSlotIds),
        memberWindowDays: enableMemberWindow ? memberWindowDays : 0,
        publicReleaseStatus: requireAdminReview ? 'pending_admin_review' : 'auto_release_scheduled',
      });

      let notified = 0;
      if (createPriorityClaims && notifyPlayers && result.notifiableSlotIds.length > 0) {
        notified = await notifyPriorityClaimsForSlots(result.notifiableSlotIds);
      }

      const parts = [t('bulkCopy.successSlots', { count: result.copiedSlots, defaultValue: '{{count}} trainings copied' })];
      if (createPriorityClaims) parts.push(t('bulkCopy.successInvited', { count: result.createdClaims, defaultValue: '{{count}} players invited' }));
      if (notified > 0) parts.push(t('bulkCopy.successEmails', { count: notified, defaultValue: '{{count}} emails sent' }));
      toast.success(parts.join(' · '));
      navigate(backHref);
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('bulkCopy.errSubmit', 'Could not copy the cycle. Please try again.')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingCycles) return <div className="container max-w-3xl mx-auto py-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Back')}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t('bulkCopy.title', 'Volgende ronde opzetten')}</h1>
        <p className="text-muted-foreground">{t('bulkCopy.subtitle', 'Hergebruik de trainingen van een vorige cyclus en laat je huidige spelers als eerste hun vaste plek houden.')}</p>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('bulkCopy.cycles', 'Welke cyclus?')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('bulkCopy.source', 'Kopieer van')}</Label>
            <Select value={sourceCycleId} onValueChange={setSourceCycleId}>
              <SelectTrigger><SelectValue placeholder={t('bulkCopy.selectCycle', 'Kies een cyclus')} /></SelectTrigger>
              <SelectContent>
                {cycles.map((c) => <SelectItem key={c.id} value={c.id}>{cyclusLabel(c)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            <Label>{t('bulkCopy.target', 'Naar')}</Label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={targetMode === 'new'} onChange={() => setTargetMode('new')} />
                {t('bulkCopy.newCycle', 'Nieuwe cyclus aanmaken')}
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={targetMode === 'existing'} onChange={() => setTargetMode('existing')} />
                {t('bulkCopy.existingCycle', 'Bestaande cyclus kiezen')}
              </label>
            </div>

            {targetMode === 'new' ? (
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">{t('bulkCopy.newName', 'Naam')}</Label>
                  <Input value={newCycleName} onChange={(e) => setNewCycleName(e.target.value)} placeholder="bv. Najaar 2026" />
                </div>
                <div>
                  <Label className="text-xs">{t('bulkCopy.newStart', 'Startdatum')}</Label>
                  <DateInputField value={newCycleStart} onChange={(e) => setNewCycleStart(e.target.value)} />
                </div>
              </div>
            ) : (
              <Select value={targetCycleId} onValueChange={setTargetCycleId}>
                <SelectTrigger><SelectValue placeholder={t('bulkCopy.selectCycle', 'Kies een cyclus')} /></SelectTrigger>
                <SelectContent>
                  {cycles.filter((c) => c.id !== sourceCycleId).map((c) => <SelectItem key={c.id} value={c.id}>{cyclusLabel(c)}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {weeksOffset !== 0 && (
              <p className="text-xs text-muted-foreground">{t('bulkCopy.shiftWeeks', { count: weeksOffset, defaultValue: 'De trainingen verschuiven {{count}} weken.' })}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {sourceSlots.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('bulkCopy.slots', 'Slots')} ({sourceSlots.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-80 overflow-auto">
              {sourceSlots.map((s) => {
                const start = new Date(s.start_time);
                const excluded = excludeSlotIds.has(s.id);
                const count = bookingCounts.get(s.id) ?? 0;
                return (
                  <label key={s.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer">
                    <Checkbox checked={!excluded} onCheckedChange={() => toggleExclude(s.id)} />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">
                        {formatDate(start, 'EEE d MMM')}{' '}
                        {start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {t('bulkCopy.playerCount', { count, defaultValue: '{{count}} players' })}{s.price_per_session ? ` · ${formatCurrency(Number(s.price_per_session))}` : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t('bulkCopy.window', 'Spelers hun plek laten houden')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <Checkbox checked={createPriorityClaims} onCheckedChange={(v) => setCreatePriorityClaims(Boolean(v))} />
            <span className="text-sm">{t('bulkCopy.createClaims', 'Geef de huidige spelers als eerste de kans hun vaste plek te houden')}</span>
          </label>
          {createPriorityClaims && (
            <>
              <div className="max-w-xs">
                <Label>{t('bulkCopy.windowDays', 'Hoeveel dagen krijgen ze de tijd?')}</Label>
                <Input type="number" min={1} max={60} value={priorityWindowDays} onChange={(e) => setPriorityWindowDays(Number(e.target.value))} />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('bulkCopy.windowHint', 'De plek blijft gereserveerd voor de speler totdat die nee zegt of deze periode voorbij is.')}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t('bulkCopy.paymentModeLabel', 'How do players pay when they keep their spot?')}</Label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={rebookPaymentMode === 'deferred_split'}
                    onChange={() => setRebookPaymentMode('deferred_split')}
                  />
                  <span>{t('bulkCopy.paymentModeDeferred', 'Invoice at cycle start — the price is split between everyone who joins')}</span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    className="mt-1"
                    checked={rebookPaymentMode === 'upfront'}
                    onChange={() => setRebookPaymentMode('upfront')}
                  />
                  <span>{t('bulkCopy.paymentModeUpfront', 'Pay immediately — the player checks out online when they say yes')}</span>
                </label>
                {rebookPaymentMode === 'upfront' && (
                  <p className="text-xs text-muted-foreground pl-6">
                    {t('bulkCopy.paymentModeUpfrontHint', 'Requires online payments (Mollie) for the trainer or academy.')}
                  </p>
                )}
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <Checkbox checked={notifyPlayers} onCheckedChange={(v) => setNotifyPlayers(Boolean(v))} />
                <span className="text-sm">{t('bulkCopy.notifyPlayers', 'Stuur spelers meteen een e-mail met een ja/nee knop')}</span>
              </label>
            </>
          )}
        </CardContent>
      </Card>

      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
          <ChevronDown className={`h-4 w-4 mr-1 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          {t('bulkCopy.advanced', 'Geavanceerde opties')}
        </Button>
      </div>

      {showAdvanced && (
        <>
          <Card>
            <CardHeader><CardTitle>{t('bulkCopy.memberWindow', 'Member window')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <Checkbox checked={enableMemberWindow} onCheckedChange={(v) => setEnableMemberWindow(Boolean(v))} />
                <span className="text-sm">{t('bulkCopy.enableMemberWindow', 'Give previous-cycle players early access before opening publicly')}</span>
              </label>
              {enableMemberWindow && (
                <div className="max-w-xs">
                  <Label>{t('bulkCopy.memberDays', 'Member window length (days)')}</Label>
                  <Input type="number" min={1} max={60} value={memberWindowDays} onChange={(e) => setMemberWindowDays(Number(e.target.value))} />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('bulkCopy.memberHint', 'After the priority window, only players from the source cycle can book or switch into these slots.')}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('bulkCopy.publicRelease', 'Public release')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={!requireAdminReview} onCheckedChange={(v) => setRequireAdminReview(!v)} />
                <div>
                  <div className="text-sm font-medium">{t('bulkCopy.autoRelease', 'Auto-release after member window')}</div>
                  <div className="text-xs text-muted-foreground">{t('bulkCopy.autoReleaseHint', 'Slots open to the public automatically when the member window ends.')}</div>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={requireAdminReview} onCheckedChange={(v) => setRequireAdminReview(Boolean(v))} />
                <div>
                  <div className="text-sm font-medium">{t('bulkCopy.requireReview', 'Require my approval before public')}</div>
                  <div className="text-xs text-muted-foreground">{t('bulkCopy.requireReviewHint', 'Slots stay hidden until you review and release them from the cycles page.')}</div>
                </div>
              </label>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex justify-end">
        <Button
          onClick={handleSubmit}
          disabled={
            submitting ||
            !sourceCycleId ||
            (targetMode === 'new' ? !newCycleStart : !targetCycleId)
          }
        >
          {createPriorityClaims && notifyPlayers ? <Send className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
          {submitting
            ? t('common:saving', 'Bezig...')
            : createPriorityClaims && notifyPlayers
              ? t('bulkCopy.confirmNotify', 'Aanmaken & spelers uitnodigen')
              : t('bulkCopy.confirm', 'Trainingen kopiëren')}
        </Button>
      </div>
    </div>
  );
}
