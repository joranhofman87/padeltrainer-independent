import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addWeeks, format, startOfDay } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Send } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { drainRebookRoundInvites } from '@/lib/rebookInviteSend';
import { getCycles, type Cycle } from '@/lib/cycles';
import { fetchCyclusLabels, buildCyclusLabel, type CyclusRosterEntry } from '@/lib/cyclusLabel';
import type { RebookPaymentMode } from '@/lib/priorityClaims';
import { HolidayRangeEditor } from './HolidayRangeEditor';
import { RebookAccessWindows } from './RebookAccessWindows';
import { RebookReviewTable, type RebookGroupDetail } from './RebookReviewTable';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { EmailSubjectField } from '@/components/email/EmailSubjectField';
import { RebookRulesField } from '@/components/cycles/RebookRulesField';
import { normalizeRichTextHtml } from '@/lib/richText';
import { RebookPaymentModeField } from './RebookPaymentModeField';
import { RebookPriorityListField, type PriorityPerson } from './RebookPriorityListField';

interface Props {
  academyProfileId: string;
  backHref: string;
}

interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

// Review summary returned by the dryRun before anything is created/emailed.
interface ReviewData {
  groups: number;
  players: number;
  totalSessions: number;
  effWeeks: number;
  suggestedPrice: number | null;
  groupsDetail: RebookGroupDetail[];
  noEmailTotal: number;
  grandInvoiceTotal: number;
}

/**
 * Academy "new round" / rebook wizard, keyed on a SOURCE CYCLUS.
 *
 * Mirrors creating a new session (start date, number of weeks, price per
 * session) and reuses the /slot/new date picker. It drives the same
 * `bulk-rebook-cycle` edge function as RebookCohortWizard — which clusters the
 * cyclus's slots into ONE weekly series and GENERATES N weeks (skipping
 * holidays) rather than copying every source slot 1:1 — and shows a stepped
 * preview of exactly what will be created + emailed before sending.
 */
export default function AcademyNewRoundWizard({ academyProfileId, backHref }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cyclusLabels, setCyclusLabels] = useState<Map<string, CyclusRosterEntry>>(new Map());
  const [loadingCycles, setLoadingCycles] = useState(true);

  const [step, setStep] = useState<'configure' | 'review'>('configure');

  const [sourceCyclusId, setSourceCyclusId] = useState<string>(searchParams.get('source') ?? '');
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [sessionPrice, setSessionPrice] = useState('');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);
  const [targetCycleName, setTargetCycleName] = useState(
    t('newRound.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
  );

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [strictMollie, setStrictMollie] = useState(false);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  // Automated reminder to non-responders ~24h before their priority window closes.
  const [autoReminder, setAutoReminder] = useState(true);

  const [review, setReview] = useState<ReviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Live invite-drain progress ({ sent, total }) while a large round emails out.
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  const [ackNoEmail, setAckNoEmail] = useState(false);
  // Pre-fill a warm, personalised default so a new academy starts from something instead of
  // a blank box; fully editable. Leads with "Hoi {first_name}," (substituted per recipient).
  const [invitationMessage, setInvitationMessage] = useState(() => t('rebookShared.defaultInviteMessage'));
  const [invitationSubject, setInvitationSubject] = useState(() => t('rebookShared.defaultInviteSubject'));
  // The automated-reminder email text (used by auto-rebook-reminder; also pre-fills the manual send).
  const [reminderMessage, setReminderMessage] = useState(() => t('rebookShared.defaultReminderMessage'));
  const [reminderSubject, setReminderSubject] = useState(() => t('rebookShared.defaultReminderSubject'));
  const [rebookRules, setRebookRules] = useState('');
  // Priority list: registered players who also get first dibs (+ an email) when the
  // member window opens, plus the optional message for that "sessions opened" email.
  const [priorityPeople, setPriorityPeople] = useState<PriorityPerson[]>([]);
  const [priorityMessage, setPriorityMessage] = useState('');

  // The priority list is only honoured during the member window, so selecting anyone
  // force-enables it (and the toggle is disabled while the list is non-empty).
  useEffect(() => {
    if (priorityPeople.length > 0 && !enableMemberWindow) setEnableMemberWindow(true);
  }, [priorityPeople, enableMemberWindow]);

  useEffect(() => {
    getCycles('academy', academyProfileId)
      .then(setCycles)
      .catch((e) => toast.error(getFriendlyErrorMessage(e, t('newRound.errLoadCycles', 'Kon de cycli niet laden. Probeer het opnieuw.'))))
      .finally(() => setLoadingCycles(false));
  }, [academyProfileId, t]);

  // Enrich the source dropdown with each cyclus's day/time + roster + location.
  useEffect(() => {
    fetchCyclusLabels('academy', academyProfileId).then(setCyclusLabels);
  }, [academyProfileId]);

  const cyclusLabel = (c: Cycle): string => buildCyclusLabel(cyclusLabels.get(c.id)) ?? c.name;

  // Only genuine weekly training cycli are rebookable. Hide event/registration
  // cycles (no weekly series → an empty round) and rounds this wizard itself
  // generated (they carry a rebook_* settings marker) so a "Volgende ronde" can't
  // be picked as a source and rebooked again.
  const sourceCycles = useMemo(
    () => cycles.filter((c) => c.type === 'cyclus' && !c.settings?.rebook_payment_mode),
    [cycles],
  );

  const newStartDate = startDate ? format(startDate, 'yyyy-MM-dd') : '';
  const newEndDate = endDate ? format(endDate, 'yyyy-MM-dd') : '';
  const inputsValid = Boolean(sourceCyclusId) && Boolean(newStartDate);

  const baseBody = useMemo(
    () => ({
      sourceCyclusId,
      newStartDate,
      priorityWindowDays,
      memberWindowDays: enableMemberWindow ? memberWindowDays : 0,
      paymentMode,
      strictMollie: paymentMode === 'upfront' && strictMollie,
      requireAdminReview,
      targetCycleName: targetCycleName.trim(),
      // Date model: the round runs from newStartDate to newEndDate; the number of sessions is
      // derived from that range minus the holiday days. When the end date is left blank, the
      // edge fn falls back to the previous round's length (suggestedWeeks).
      newEndDate: newEndDate || null,
      sessionPrice: sessionPrice === '' ? null : Number(sessionPrice),
      holidays: holidays.filter((h) => h.from && h.to),
      invitationMessage: invitationMessage.trim() || null,
      invitationSubject: invitationSubject.trim() || null,
      reminderMessage: reminderMessage.trim() || null,
      reminderSubject: reminderSubject.trim() || null,
      rebookRules: normalizeRichTextHtml(rebookRules),
      // Split by type: registered profiles vs accountless guests (two separate settings arrays,
      // each with its own can_book_member_window clause).
      priorityPeople: priorityPeople.filter((p) => p.player_type === 'registered').map((p) => p.id),
      priorityGuests: priorityPeople.filter((p) => p.player_type === 'guest').map((p) => p.id),
      memberOpenMessage: priorityMessage.trim() || null,
      autoReminder,
    }),
    [sourceCyclusId, newStartDate, newEndDate, priorityWindowDays, enableMemberWindow, memberWindowDays, paymentMode, strictMollie, requireAdminReview, targetCycleName, sessionPrice, holidays, invitationMessage, invitationSubject, reminderMessage, reminderSubject, rebookRules, priorityPeople, priorityMessage, autoReminder],
  );

  // Step 1 → 2: dryRun to compute exactly what will be created + emailed.
  const handleReview = async () => {
    if (!inputsValid) {
      toast.error(t('newRound.errFillRequired', 'Kies een cyclus en een startdatum.'));
      return;
    }
    setPreviewing(true);
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
        body: { ...baseBody, dryRun: true },
      });
      if (error) throw error;
      const players = Number(data?.players ?? 0);
      if (players === 0) {
        toast.info(t('newRound.previewEmpty', 'Geen spelers gevonden in deze cyclus.'));
        return;
      }
      // Pre-fill the end date + price from the previous round when the user left them blank.
      // The last session lands (weeks-1) weeks after the start, so that's the suggested end date —
      // the user sees a concrete range they can shorten/extend and re-check.
      const suggestedWeeks = Number(data?.suggestedWeeks ?? 0);
      const suggestedPrice = data?.suggestedPrice == null ? null : Number(data.suggestedPrice);
      if (!endDate && startDate && suggestedWeeks > 0) setEndDate(startOfDay(addWeeks(startDate, suggestedWeeks - 1)));
      if (sessionPrice === '' && suggestedPrice != null) setSessionPrice(String(suggestedPrice));
      setAckNoEmail(false);
      setReview({
        groups: Number(data?.groups ?? 0),
        players,
        totalSessions: Number(data?.totalSessions ?? 0),
        effWeeks: Number(data?.effWeeks ?? 0),
        suggestedPrice,
        groupsDetail: Array.isArray(data?.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : [],
        noEmailTotal: Number(data?.noEmailTotal ?? 0),
        grandInvoiceTotal: Number(data?.grandInvoiceTotal ?? 0),
      });
      setStep('review');
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('newRound.errPreview', 'Kon de preview niet ophalen. Probeer het opnieuw.')));
    } finally {
      setPreviewing(false);
    }
  };

  // Step 2: create the round (fast), THEN drain the invite emails from the client
  // in bounded, resumable chunks. This avoids one giant edge invocation that could
  // hit the wall-clock and silently partial-send a large first blast.
  const handleSubmit = async () => {
    if (!inputsValid || !review || review.players <= 0 || submitting) return;
    setSubmitting(true);
    setSendProgress(null);
    try {
      // 1. Create the round + claims WITHOUT sending (skipInvites) — returns fast.
      //    roundAware:true tells the engine we can drain a MULTI-cycle round (one cycle per
      //    series); without it a multi-target run sends inline so an old client never strands
      //    sibling cycles' invites.
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
        body: { ...baseBody, skipInvites: true, roundAware: true },
      });
      if (error) throw error;
      if (data?.ok === false && data?.reason === 'already_exists') {
        toast.error(t('newRound.alreadyExists', 'Er bestaat al een ronde met deze naam en startdatum. Geef de nieuwe ronde een andere naam of datum.'));
        return;
      }
      if (data?.ok === false && data?.reason === 'slot_overlap') {
        toast.error(t('newRound.slotOverlap', 'De nieuwe periode botst met bestaande sessies van deze trainer. Kies een andere startdatum of tijd.'));
        return;
      }
      const newCycleId = data?.targetCycleId as string | undefined;
      // A per-series run returns all sibling cycles; drain invites across ALL of them.
      const roundCycleIds: string[] = Array.isArray(data?.targetCycles) && data.targetCycles.length > 0
        ? (data.targetCycles as Array<{ id: string }>).map((c) => c.id)
        : (newCycleId ? [newCycleId] : []);
      const total = Number(data?.representativeCount ?? data?.players ?? 0);

      // 2. Drain the invites with live progress — but ONLY when the edge fn actually
      //    deferred them (invitesDeferred). If an older bulk-rebook-cycle is still
      //    deployed it sent inline and ignored skipInvites; fall back to its own
      //    invitesSent/failedClaimIds so we never mis-report during a deploy gap.
      if (roundCycleIds.length > 0 && total > 0 && data?.invitesDeferred === true) {
        setSendProgress({ sent: 0, total });
        const result = await drainRebookRoundInvites(roundCycleIds, {
          customMessage: baseBody.invitationMessage,
          customSubject: baseBody.invitationSubject,
          // Prefer the drain's sendable total (excludes emailless reps) once known.
          onProgress: ({ totalSent, total: sendable }) => setSendProgress({ sent: totalSent, total: sendable || total }),
        });
        if (result.leftover > 0 || result.stoppedReason === 'error') {
          // Round is created; some invites still need sending — the owner can finish
          // from the rebook page ("resume sending"), and players can also respond via
          // their dashboard.
          toast.warning(
            t('newRound.invitesPartial', '{{sent}} van {{total}} uitnodigingen verstuurd. De ronde is aangemaakt — verstuur de rest via de ronde-pagina.', {
              sent: result.totalSent,
              total,
            }),
            // Surface WHY the rest didn't send (a Resend rejection / error reason from the edge fn),
            // instead of leaving the owner to dig through logs.
            result.sampleError ? { description: result.sampleError } : undefined,
          );
        } else {
          toast.success(
            t('newRound.success', '{{groups}} groep(en) · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
              groups: Number(data?.groups ?? 0),
              players: Number(data?.players ?? 0),
              invites: result.totalSent,
            }),
          );
        }
      } else {
        // Inline-send path (older edge fn, or nothing to send): report what it sent.
        toast.success(
          t('newRound.success', '{{groups}} groep(en) · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
            groups: Number(data?.groups ?? 0),
            players: Number(data?.players ?? 0),
            invites: Number(data?.invitesSent ?? 0),
          }),
        );
        const failedCount = Array.isArray(data?.failedClaimIds) ? data.failedClaimIds.length : 0;
        if (failedCount > 0) {
          toast.warning(
            t('newRound.invitesPartialLegacy', '{{count}} uitnodiging(en) konden niet worden verstuurd. De ronde is aangemaakt; deze spelers kunnen ook via hun dashboard reageren.', { count: failedCount }),
          );
        }
      }
      // Land on the new cycle's rebook management view (falls back to backHref).
      navigate(newCycleId ? `/app/academy/cycles/${newCycleId}/rebook` : backHref);
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('newRound.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
    } finally {
      setSubmitting(false);
      setSendProgress(null);
    }
  };

  if (loadingCycles) {
    return (
      <div className="container max-w-3xl mx-auto py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const effPrice = sessionPrice || (review?.suggestedPrice != null ? String(review.suggestedPrice) : '');

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Terug')}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t('newRound.title', 'Volgende ronde opzetten')}</h1>
        <p className="text-muted-foreground">
          {t('newRound.subtitle', 'Kies een cyclus, een startdatum en het aantal weken. We maken één nieuwe ronde aan en geven je huidige spelers als eerste de kans hun vaste plek te houden.')}
        </p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('font-medium', step === 'configure' ? 'text-foreground' : 'text-muted-foreground')}>
          1. {t('newRound.stepConfigure', 'Instellen')}
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
        <span className={cn('font-medium', step === 'review' ? 'text-foreground' : 'text-muted-foreground')}>
          2. {t('newRound.stepReview', 'Controleren & versturen')}
        </span>
      </div>

      {step === 'configure' && (
        <>
          <Card>
            <CardHeader><CardTitle>{t('newRound.source', 'Welke cyclus kopiëren?')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">{t('newRound.sourceLabel', 'Cyclus')}</Label>
                <Select value={sourceCyclusId} onValueChange={(v) => { setSourceCyclusId(v); setReview(null); }}>
                  <SelectTrigger><SelectValue placeholder={t('newRound.selectCyclus', 'Kies een cyclus')} /></SelectTrigger>
                  <SelectContent>
                    {sourceCycles.map((c) => <SelectItem key={c.id} value={c.id}>{cyclusLabel(c)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('newRound.sourceHint', 'We nemen het wekelijkse patroon en de spelers van deze cyclus over.')}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('newRound.whenAndHowMany', 'Wanneer loopt de ronde?')}</CardTitle></CardHeader>
            <CardContent className="grid sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.startDate', 'Startdatum')}</Label>
                <DatePickerPopover
                  value={startDate}
                  onChange={(d) => { if (d) { setStartDate(startOfDay(d)); setReview(null); } }}
                  disabled={(date) => date < startOfDay(new Date())}
                  className="w-full"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.endDate', 'Einddatum')}</Label>
                <DatePickerPopover
                  value={endDate}
                  onChange={(d) => { if (d) { setEndDate(startOfDay(d)); setReview(null); } }}
                  disabled={(date) => (startDate ? date < startDate : date < startOfDay(new Date()))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">{t('newRound.endDateHint', 'Leeg = lengte van de vorige ronde. Vakantiedagen worden niet ingepland.')}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.sessionPrice', 'Prijs per sessie (€)')}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={sessionPrice}
                  onChange={(e) => setSessionPrice(e.target.value)}
                  placeholder="0.00"
                />
                <p className="text-xs text-muted-foreground">{t('newRound.sessionPriceHint', 'Geldt voor elke sessie in de nieuwe ronde.')}</p>
              </div>
            </CardContent>
          </Card>

          <HolidayRangeEditor holidays={holidays} onChange={setHolidays} />

          <Card>
            <CardHeader><CardTitle>{t('newRound.targetName', 'Naam nieuwe ronde')}</CardTitle></CardHeader>
            <CardContent>
              <Input value={targetCycleName} onChange={(e) => setTargetCycleName(e.target.value)} placeholder={t('newRound.targetNamePlaceholder', 'bv. Najaar 2026')} />
            </CardContent>
          </Card>

          {/* Payment + access settings are core decisions, not "advanced" — always visible
              (the old collapsible buried the payment mode, which owners must consciously pick). */}
          <RebookPaymentModeField
            academyProfileId={academyProfileId}
            paymentMode={paymentMode}
            setPaymentMode={setPaymentMode}
            strictMollie={strictMollie}
            setStrictMollie={setStrictMollie}
          />

          <RebookAccessWindows
            priorityWindowDays={priorityWindowDays}
            setPriorityWindowDays={setPriorityWindowDays}
            enableMemberWindow={enableMemberWindow}
            setEnableMemberWindow={setEnableMemberWindow}
            memberWindowDays={memberWindowDays}
            setMemberWindowDays={setMemberWindowDays}
            lockMemberWindow={priorityPeople.length > 0}
            lockMemberWindowHint={t('newRound.priorityRequiresMember', 'De voorrangslijst gebruikt het ledenvenster; dit staat daarom aan.')}
          />

          {/* The priority list rides on the member window (that's when these people get first
              dibs on freed seats) — without it the list does nothing, so only show it then. */}
          {enableMemberWindow && (
            <Card>
              <CardHeader><CardTitle>{t('newRound.priorityListTitle', 'Voorrangslijst')}</CardTitle></CardHeader>
              <CardContent>
                <RebookPriorityListField
                  academyProfileId={academyProfileId}
                  value={priorityPeople}
                  onChange={setPriorityPeople}
                  message={priorityMessage}
                  onMessageChange={setPriorityMessage}
                  disabled={submitting}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>{t('newRound.publicRelease', 'Publiek vrijgeven')}</CardTitle></CardHeader>
            <CardContent>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={requireAdminReview} onCheckedChange={(v) => setRequireAdminReview(Boolean(v))} />
                <div>
                  <div className="text-sm font-medium">{t('newRound.requireReview', 'Mijn goedkeuring vereist voordat het publiek wordt')}</div>
                  <div className="text-xs text-muted-foreground">{t('newRound.requireReviewHint', 'De plekken blijven verborgen totdat je ze zelf vrijgeeft.')}</div>
                </div>
              </label>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleReview} disabled={previewing || !inputsValid}>
              {previewing ? t('common:loading', 'Bezig...') : t('newRound.toReview', 'Controleren')}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </>
      )}

      {step === 'review' && review && (
        <>
          <Card>
            <CardHeader><CardTitle>{t('newRound.reviewTitle', 'Dit gaat er gebeuren')}</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                {t('newRound.reviewIntroRange', 'Je maakt "{{name}}" aan van {{start}} t/m {{end}}, € {{price}} per sessie:', {
                  name: targetCycleName.trim() || t('newRound.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
                  start: newStartDate,
                  end: newEndDate || newStartDate,
                  price: effPrice || '—',
                })}
              </p>
              {holidays.filter((h) => h.from && h.to).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('newRound.reviewHolidayNote', '{{count}} vakantieperiode wordt niet ingepland — die sessies zitten niet in de aantallen hieronder.', { count: holidays.filter((h) => h.from && h.to).length })}
                </p>
              )}
              <RebookReviewTable
                groups={review.groupsDetail}
                noEmailTotal={review.noEmailTotal}
                grandInvoiceTotal={review.grandInvoiceTotal}
                ackNoEmail={ackNoEmail}
                onAckChange={setAckNoEmail}
                paymentMode={paymentMode}
              />
              {holidays.filter((h) => h.from && h.to).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('newRound.reviewHolidays', 'Vakanties overgeslagen: {{names}}', {
                    names: holidays.filter((h) => h.from && h.to).map((h) => h.name || `${h.from}–${h.to}`).join(', '),
                  })}
                </p>
              )}
              <p className="font-medium">
                {t('newRound.reviewEmails', '{{players}} spelers krijgen nu een uitnodiging per e-mail.', {
                  players: Math.max(0, review.players - review.noEmailTotal),
                })}
              </p>
              <div className="space-y-3 rounded-md border p-3">
                <EmailSubjectField
                  id="rebook-invite-subject"
                  value={invitationSubject}
                  onChange={setInvitationSubject}
                  disabled={submitting}
                  label={t('newRound.inviteSubjectLabel', 'Onderwerp van de uitnodiging (optioneel)')}
                  placeholder={t('newRound.inviteSubjectPlaceholder', 'Reserveer je plek voor de volgende cyclus')}
                  variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
                />
                <EmailMessageField
                  id="rebook-invite-message"
                  value={invitationMessage}
                  onChange={setInvitationMessage}
                  disabled={submitting}
                  maxLength={2000}
                  label={t('newRound.inviteMessageLabel', 'Persoonlijk bericht in de uitnodiging (optioneel)')}
                  placeholder={t('newRound.inviteMessagePlaceholder', 'Bijv. Leuk dat je er weer bij bent! Bevestig hieronder je vaste plek voor de volgende ronde.')}
                  variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
                />
              </div>
              {/* The automated reminder lives HERE with the other email content (owner request):
                  everything a player will receive is written/reviewed in one place. */}
              <div className="space-y-3 rounded-md border p-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <Checkbox checked={autoReminder} onCheckedChange={(v) => setAutoReminder(Boolean(v))} className="mt-0.5" />
                  <div>
                    <div className="text-sm font-medium">{t('rebookShared.autoReminder', 'Automatisch herinneren')}</div>
                    <div className="text-xs text-muted-foreground">{t('rebookShared.autoReminderHint', 'Stuur spelers die nog niet reageerden automatisch een herinnering vlak voordat hun voorrang verloopt.')}</div>
                  </div>
                </label>
                {autoReminder && (
                  <div className="space-y-3 pl-7">
                    <EmailSubjectField
                      id="rebook-reminder-subject"
                      value={reminderSubject}
                      onChange={setReminderSubject}
                      disabled={submitting}
                      label={t('rebookShared.reminderSubjectLabel', 'Onderwerp van de herinnering')}
                      placeholder={t('rebookShared.defaultReminderSubject', 'Herinnering: bevestig je plek')}
                      variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
                    />
                    <EmailMessageField
                      id="rebook-reminder-message"
                      value={reminderMessage}
                      onChange={setReminderMessage}
                      disabled={submitting}
                      maxLength={2000}
                      label={t('rebookShared.reminderMessageLabel', 'Bericht in de herinnering')}
                      placeholder={t('rebookShared.defaultReminderMessage', '')}
                      variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
                    />
                  </div>
                )}
              </div>
              <div className="rounded-md border p-3">
                <RebookRulesField
                  academyProfileId={academyProfileId}
                  value={rebookRules}
                  onChange={setRebookRules}
                  disabled={submitting}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('configure')} disabled={submitting}>
              <ArrowLeft className="h-4 w-4 mr-2" /> {t('newRound.backToConfigure', 'Aanpassen')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || (review.noEmailTotal > 0 && !ackNoEmail)}
            >
              <Send className="h-4 w-4 mr-2" />
              {sendProgress
                ? t('newRound.sending', 'Uitnodigingen versturen… {{sent}}/{{total}}', { sent: sendProgress.sent, total: sendProgress.total })
                : submitting
                  ? t('common:saving', 'Bezig...')
                  : t('newRound.confirmSend', 'Aanmaken & spelers uitnodigen')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
