import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addWeeks, format, parse } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Send, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { getAcademyLocationsWithDetails } from '@/lib/academy';
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

interface LocationOption {
  id: string;
  name: string;
  city: string;
}

interface PreviewResult {
  groups: number;
  players: number;
  suggestedWeeks: number;
  suggestedPrice: number | null;
  pricesIncludeVat: boolean | null;
}

interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

interface ConfirmData {
  groups: number;
  players: number;
  totalSessions: number;
  effWeeks: number;
  groupsDetail: RebookGroupDetail[];
  noEmailTotal: number;
  grandInvoiceTotal: number;
}

/** A calendar date field over a yyyy-MM-dd string value (matches the app's other date pickers). */
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const selected = value ? parse(value, 'yyyy-MM-dd', new Date()) : undefined;
  return (
    <DatePickerPopover
      value={selected}
      onChange={(d) => onChange(d ? format(d, 'yyyy-MM-dd') : '')}
      className="w-full"
    />
  );
}

export default function RebookCohortWizard({ academyProfileId, backHref }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set());
  const [termEndDate, setTermEndDate] = useState('');
  const [newStartDate, setNewStartDate] = useState('');
  const [newEndDate, setNewEndDate] = useState('');
  const [sessionPrice, setSessionPrice] = useState('');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  // Priority list: registered players the academy manually grants early access to
  // freed seats (member window), on top of the returning cohort.
  const [priorityPeople, setPriorityPeople] = useState<PriorityPerson[]>([]);
  const [priorityMessage, setPriorityMessage] = useState('');
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [strictMollie, setStrictMollie] = useState(false);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  // Automated reminder to non-responders ~24h before their priority window closes.
  const [autoReminder, setAutoReminder] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [targetCycleName, setTargetCycleName] = useState(
    t('rebookCohort.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
  );

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmData, setConfirmData] = useState<ConfirmData | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [ackNoEmail, setAckNoEmail] = useState(false);
  // Pre-fill a warm, personalised default so a new academy starts from something instead of
  // a blank box; fully editable. Leads with "Hoi {first_name}," (substituted per recipient).
  const [invitationMessage, setInvitationMessage] = useState(() => t('rebookShared.defaultInviteMessage'));
  const [invitationSubject, setInvitationSubject] = useState(() => t('rebookShared.defaultInviteSubject'));
  const [reminderMessage, setReminderMessage] = useState(() => t('rebookShared.defaultReminderMessage'));
  const [reminderSubject, setReminderSubject] = useState(() => t('rebookShared.defaultReminderSubject'));
  const [rebookRules, setRebookRules] = useState('');
  // Trainer/session exclusion: the auto-preview's series (for the trainer checklist),
  // the excluded series (by sourceSeriesKey), and the subset whose players move to the
  // second bucket (member window). secondBucketAdded = server count for the note.
  const [previewGroups, setPreviewGroups] = useState<RebookGroupDetail[]>([]);
  const [excludedSeriesKeys, setExcludedSeriesKeys] = useState<Set<string>>(new Set());
  const [secondBucketSeriesKeys, setSecondBucketSeriesKeys] = useState<Set<string>>(new Set());
  const [secondBucketAdded, setSecondBucketAdded] = useState(0);

  useEffect(() => {
    getAcademyLocationsWithDetails(academyProfileId)
      .then((rows) => {
        setLocations(
          rows
            .filter((r) => r.location)
            .map((r) => ({ id: r.location.id, name: r.location.name, city: r.location.city || '' })),
        );
      })
      .catch((e) =>
        toast.error(
          getFriendlyErrorMessage(e, t('rebookCohort.errLoadLocations', 'Kon de locaties niet laden. Probeer het opnieuw.')),
        ),
      )
      .finally(() => setLoadingLocations(false));
  }, [academyProfileId, t]);

  const toggleLocation = (id: string) => {
    setSelectedLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The priority list rides on the member window; selecting anyone forces it on
  // (mirrors AcademyNewRoundWizard).
  useEffect(() => {
    if (priorityPeople.length > 0 && !enableMemberWindow) setEnableMemberWindow(true);
  }, [priorityPeople, enableMemberWindow]);

  const baseBody = useMemo(
    () => ({
      academyProfileId,
      locationIds: Array.from(selectedLocationIds),
      termEndDate,
      newStartDate,
      priorityWindowDays,
      memberWindowDays: enableMemberWindow ? memberWindowDays : 0,
      paymentMode,
      strictMollie: paymentMode === 'upfront' && strictMollie,
      requireAdminReview,
      targetCycleName: targetCycleName.trim(),
      // Date model: the round runs from newStartDate to newEndDate; the session count is derived
      // from that range minus the holiday days. Blank end date → previous term's length (fallback).
      newEndDate: newEndDate || null,
      sessionPrice: sessionPrice === '' ? null : Number(sessionPrice),
      holidays: holidays.filter((h) => h.from && h.to),
      invitationMessage: invitationMessage.trim() || null,
      invitationSubject: invitationSubject.trim() || null,
      reminderMessage: reminderMessage.trim() || null,
      reminderSubject: reminderSubject.trim() || null,
      rebookRules: normalizeRichTextHtml(rebookRules),
      excludedSeriesKeys: [...excludedSeriesKeys],
      secondBucketSeriesKeys: [...secondBucketSeriesKeys],
      priorityPeople: priorityPeople.filter((p) => p.player_type === 'registered').map((p) => p.id),
      priorityGuests: priorityPeople.filter((p) => p.player_type === 'guest').map((p) => p.id),
      memberOpenMessage: priorityMessage.trim() || null,
      autoReminder,
    }),
    [
      academyProfileId,
      selectedLocationIds,
      termEndDate,
      newStartDate,
      priorityWindowDays,
      enableMemberWindow,
      memberWindowDays,
      paymentMode,
      strictMollie,
      requireAdminReview,
      autoReminder,
      targetCycleName,
      newEndDate,
      sessionPrice,
      holidays,
      invitationMessage,
      invitationSubject,
      reminderMessage,
      reminderSubject,
      rebookRules,
      excludedSeriesKeys,
      secondBucketSeriesKeys,
      priorityPeople,
      priorityMessage,
    ],
  );

  const inputsValid = selectedLocationIds.size > 0 && Boolean(termEndDate) && Boolean(newStartDate);

  // Auto-count the cohort the moment location + both dates are set, shown up top —
  // no manual "preview" click. The headcount/groups depend only on the cohort inputs
  // (location + dates), so re-run only when those change (not on weeks/price typing).
  const locKey = useMemo(() => [...selectedLocationIds].sort().join(','), [selectedLocationIds]);
  useEffect(() => {
    if (!(selectedLocationIds.size > 0 && termEndDate && newStartDate)) { setPreview(null); setPreviewGroups([]); return; }
    let cancelled = false;
    setPreviewing(true);
    // The cohort changed → any trainer/session exclusions were keyed on the old series.
    setExcludedSeriesKeys(new Set());
    setSecondBucketSeriesKeys(new Set());
    const handle = setTimeout(async () => {
      try {
        const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
          body: { academyProfileId, locationIds: [...selectedLocationIds], termEndDate, newStartDate, paymentMode, requireAdminReview, dryRun: true },
        });
        if (cancelled) return;
        if (error) throw error;
        const result: PreviewResult = {
          groups: Number(data?.groups ?? 0),
          players: Number(data?.players ?? 0),
          suggestedWeeks: Number(data?.suggestedWeeks ?? 0),
          suggestedPrice: data?.suggestedPrice == null ? null : Number(data.suggestedPrice),
          pricesIncludeVat: data?.pricesIncludeVat == null ? null : Boolean(data.pricesIncludeVat),
        };
        setPreview(result);
        setPreviewGroups(Array.isArray(data?.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : []);
        // Pre-fill the end date + price from the previous term when the user hasn't set them. The last
        // session lands (weeks-1) weeks after the start → that's the suggested end date (adjustable).
        setNewEndDate((e2) => {
          if (e2 || !newStartDate || result.suggestedWeeks <= 0) return e2;
          return format(addWeeks(parse(newStartDate, 'yyyy-MM-dd', new Date()), result.suggestedWeeks - 1), 'yyyy-MM-dd');
        });
        setSessionPrice((p) => (p !== '' ? p : (result.suggestedPrice != null ? String(result.suggestedPrice) : p)));
      } catch (e) {
        if (!cancelled) {
          setPreview(null);
          toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errPreview', 'Kon de preview niet ophalen. Probeer het opnieuw.')));
        }
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academyProfileId, locKey, termEndDate, newStartDate, paymentMode, requireAdminReview]);

  // Trainer checklist (built from the auto-preview's series) + exclusion handlers.
  const previewTrainers = useMemo(() => {
    const m = new Map<string, { name: string; keys: string[] }>();
    for (const g of previewGroups) {
      if (!g.sourceSeriesKey) continue;
      const tid = g.trainerId ?? '_';
      const cur = m.get(tid) ?? { name: g.trainerName || t('rebookCohort.unknownTrainer', 'Onbekende trainer'), keys: [] as string[] };
      cur.keys.push(g.sourceSeriesKey);
      m.set(tid, cur);
    }
    return [...m.entries()].map(([id, v]) => ({ id, name: v.name, keys: v.keys }));
  }, [previewGroups, t]);

  const trainerIncluded = (keys: string[]) => keys.some((k) => !excludedSeriesKeys.has(k));

  // Excluding a series (via trainer or session) defaults to "move their players to the
  // second bucket" (owner can flip it per removal in the review table).
  const toggleTrainer = (keys: string[], include: boolean) => {
    const apply = (prev: Set<string>) => {
      const next = new Set(prev);
      keys.forEach((k) => (include ? next.delete(k) : next.add(k)));
      return next;
    };
    setExcludedSeriesKeys(apply);
    setSecondBucketSeriesKeys(apply);
  };
  const toggleExcludedKey = (key: string) => {
    const wasExcluded = excludedSeriesKeys.has(key);
    const apply = (prev: Set<string>) => {
      const next = new Set(prev);
      if (wasExcluded) next.delete(key); else next.add(key);
      return next;
    };
    setExcludedSeriesKeys(apply);
    setSecondBucketSeriesKeys(apply);
  };
  const toggleSecondBucketKey = (key: string) => {
    setSecondBucketSeriesKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Re-run the review dryRun (debounced) as exclusions change while the review is open,
  // so the distinct-player headline + totals + second-bucket count stay server-accurate.
  const baseBodyRef = useRef(baseBody);
  useEffect(() => { baseBodyRef.current = baseBody; }, [baseBody]);
  const refreshReview = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', { body: { ...baseBodyRef.current, dryRun: true } });
      if (error) throw error;
      setSecondBucketAdded(Number(data?.secondBucketAddedCount ?? 0));
      setConfirmData((prev) => (prev ? {
        groups: Number(data?.groups ?? 0),
        players: Number(data?.players ?? 0),
        totalSessions: Number(data?.totalSessions ?? 0),
        effWeeks: Number(data?.effWeeks ?? 0),
        groupsDetail: Array.isArray(data?.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : prev.groupsDetail,
        noEmailTotal: Number(data?.noEmailTotal ?? 0),
        grandInvoiceTotal: Number(data?.grandInvoiceTotal ?? 0),
      } : prev));
    } catch { /* keep the previous review on a transient error */ }
  }, []);
  const exclusionSig = useMemo(
    () => [...excludedSeriesKeys].sort().join(',') + '|' + [...secondBucketSeriesKeys].sort().join(','),
    [excludedSeriesKeys, secondBucketSeriesKeys],
  );
  const reviewOpenRef = useRef(false);
  useEffect(() => { reviewOpenRef.current = confirmData !== null; }, [confirmData]);
  useEffect(() => {
    if (!reviewOpenRef.current) return;
    const h = setTimeout(() => { refreshReview(); }, 500);
    return () => clearTimeout(h);
  }, [exclusionSig, refreshReview]);

  // Build the review summary (what will be created + emailed) BEFORE sending — a fresh
  // dryRun that reflects the chosen weeks + holidays. Opens the full-page review.
  const prepareConfirm = async () => {
    if (!inputsValid || !preview || preview.players <= 0) return;
    setPreparing(true);
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
        body: { ...baseBody, dryRun: true },
      });
      if (error) throw error;
      setAckNoEmail(false);
      setSecondBucketAdded(Number(data?.secondBucketAddedCount ?? 0));
      setConfirmData({
        groups: Number(data?.groups ?? 0),
        players: Number(data?.players ?? 0),
        totalSessions: Number(data?.totalSessions ?? 0),
        effWeeks: Number(data?.effWeeks ?? 0),
        groupsDetail: Array.isArray(data?.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : [],
        noEmailTotal: Number(data?.noEmailTotal ?? 0),
        grandInvoiceTotal: Number(data?.grandInvoiceTotal ?? 0),
      });
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errPreview', 'Kon de preview niet ophalen. Probeer het opnieuw.')));
    } finally {
      setPreparing(false);
    }
  };

  const handleSubmit = async () => {
    if (!inputsValid || !preview || preview.players <= 0 || submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
        body: baseBody,
      });
      if (error) throw error;
      if (data?.ok === false && data?.reason === 'already_exists') {
        toast.error(
          t('rebookCohort.alreadyExists', 'Er bestaat al een ronde met deze naam en startdatum. Geef de nieuwe ronde een andere naam of datum.'),
        );
        return;
      }
      if (data?.ok === false && data?.reason === 'slot_overlap') {
        toast.error(t('newRound.slotOverlap', 'De nieuwe periode botst met bestaande sessies van deze trainer. Kies een andere startdatum of tijd.'));
        return;
      }
      toast.success(
        t('rebookCohort.success', '{{groups}} groepen · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
          groups: Number(data?.groups ?? 0),
          players: Number(data?.players ?? 0),
          invites: Number(data?.invitesSent ?? 0),
        }),
      );
      // Land on the new cycle's rebook management view so the academy can track
      // responses / payments and manage the round (falls back to backHref).
      const newCycleId = data?.targetCycleId as string | undefined;
      navigate(newCycleId ? `/app/academy/cycles/${newCycleId}/rebook` : backHref);
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingLocations) {
    return (
      <div className="container max-w-3xl mx-auto py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // ===== Review (full page, not a popup — handles a large roster) =====
  if (confirmData) {
    const emailCount = Math.max(0, confirmData.players - confirmData.noEmailTotal);
    return (
      <div className="container max-w-3xl mx-auto px-4 py-6 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => { setConfirmData(null); setAckNoEmail(false); }} disabled={submitting}>
          <ArrowLeft className="h-4 w-4 mr-2" /> {t('rebookCohort.backToEdit', 'Terug naar bewerken')}
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{t('rebookCohort.confirmTitle', 'Controleer voordat je verstuurt')}</h1>
          <p className="text-muted-foreground">
            {t('rebookCohort.confirmIntroRange', 'Je maakt "{{name}}" aan van {{start}} t/m {{end}}, € {{price}} per sessie. Dit nodigt de volgende spelers nu per e-mail uit:', {
              name: targetCycleName.trim() || t('rebookCohort.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
              start: newStartDate ? format(parse(newStartDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : newStartDate,
              end: newEndDate ? format(parse(newEndDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : (newStartDate ? format(parse(newStartDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : ''),
              price: sessionPrice || (preview?.suggestedPrice ?? ''),
            })}
          </p>
          {holidays.filter((h) => h.from && h.to).length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.confirmHolidayNote', '{{count}} vakantieperiode wordt niet ingepland — die sessies zitten niet in de aantallen hieronder.', { count: holidays.filter((h) => h.from && h.to).length })}
            </p>
          )}
        </div>
        <RebookReviewTable
          groups={confirmData.groupsDetail}
          noEmailTotal={confirmData.noEmailTotal}
          grandInvoiceTotal={confirmData.grandInvoiceTotal}
          locationName={(id) => locations.find((l) => l.id === id)?.name}
          ackNoEmail={ackNoEmail}
          onAckChange={setAckNoEmail}
          interactive
          excludedKeys={excludedSeriesKeys}
          secondBucketKeys={secondBucketSeriesKeys}
          onToggleExcluded={toggleExcludedKey}
          onToggleSecondBucket={toggleSecondBucketKey}
          summary={{ groups: confirmData.groups, players: confirmData.players, sessions: confirmData.totalSessions }}
        />
        <p className="text-sm font-medium">
          {t('rebookCohort.confirmEmails', '{{players}} spelers krijgen nu een uitnodiging per e-mail.', { players: emailCount })}
        </p>
        {secondBucketAdded > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('rebookCohort.secondBucketNote', '{{n}} spelers uit weggelaten sessies mogen straks andere vrijgekomen plekken boeken (+ een e-mail zodra die opengaan).', { n: secondBucketAdded })}
          </p>
        )}
        <div className="space-y-3 rounded-md border p-3">
          <EmailSubjectField
            id="rebook-invite-subject"
            value={invitationSubject}
            onChange={setInvitationSubject}
            disabled={submitting}
            label={t('rebookCohort.inviteSubjectLabel', 'Onderwerp van de uitnodiging (optioneel)')}
            placeholder={t('rebookCohort.inviteSubjectPlaceholder', 'Reserveer je plek voor de volgende cyclus')}
            variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
          />
          <EmailMessageField
            id="rebook-invite-message"
            value={invitationMessage}
            onChange={setInvitationMessage}
            disabled={submitting}
            maxLength={2000}
            label={t('rebookCohort.inviteMessageLabel', 'Persoonlijk bericht in de uitnodiging (optioneel)')}
            placeholder={t('rebookCohort.inviteMessagePlaceholder', 'Bijv. Leuk dat je er weer bij bent! Bevestig hieronder je vaste plek voor de volgende ronde.')}
            variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
          />
        </div>
        <div className="rounded-md border p-3">
          <RebookRulesField
            academyProfileId={academyProfileId}
            value={rebookRules}
            onChange={setRebookRules}
            disabled={submitting}
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2 sticky bottom-2 rounded-md border bg-background p-2 shadow-sm">
          <Button variant="outline" onClick={() => { setConfirmData(null); setAckNoEmail(false); }} disabled={submitting}>
            {t('common:cancel', 'Annuleren')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || (confirmData.noEmailTotal > 0 && !ackNoEmail)}>
            {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
            {submitting
              ? t('common:saving', 'Bezig...')
              : t('rebookCohort.confirmSendCount', 'Verstuur {{count}} uitnodigingen', { count: emailCount })}
          </Button>
        </div>
      </div>
    );
  }

  // ===== Configure =====
  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Terug')}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t('rebookCohort.title', 'Hele groep opnieuw boeken')}</h1>
        <p className="text-muted-foreground">
          {t(
            'rebookCohort.subtitle',
            'Kies de locatie(s) en de week waarin de huidige termijn eindigt. We zoeken de wekelijkse groepen, kopiëren ze naar de nieuwe ronde en nodigen elke speler uit.',
          )}
        </p>
      </div>

      {/* Live cohort count — appears as soon as location + dates are set */}
      {inputsValid && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-center gap-3 py-3 text-sm">
            <Users className="h-5 w-5 text-primary shrink-0" />
            {previewing && !preview ? (
              <span className="text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('rebookCohort.counting', 'Spelers tellen…')}
              </span>
            ) : preview && preview.players > 0 ? (
              <span>
                <span className="font-semibold">{t('rebookCohort.cohortCount', 'Dit betreft {{players}} spelers in {{groups}} groepen.', { players: preview.players, groups: preview.groups })}</span>
                {preview.suggestedWeeks > 0 && (
                  <span className="text-muted-foreground"> {t('rebookCohort.cohortWeeks', '± {{count}} weken per groep.', { count: preview.suggestedWeeks })}</span>
                )}
              </span>
            ) : preview ? (
              <span className="text-muted-foreground">{t('rebookCohort.previewEmpty', 'Geen spelers gevonden voor deze selectie.')}</span>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.locations', 'Welke locatie(s)?')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('rebookCohort.noLocations', 'Je hebt nog geen locaties. Voeg eerst een locatie toe.')}
            </p>
          ) : (
            locations.map((loc) => (
              <label key={loc.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer">
                <Checkbox checked={selectedLocationIds.has(loc.id)} onCheckedChange={() => toggleLocation(loc.id)} />
                <div className="text-sm">
                  <div className="font-medium">{loc.name}</div>
                  {loc.city && <div className="text-muted-foreground text-xs">{loc.city}</div>}
                </div>
              </label>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.dates', 'Wanneer?')}</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-3 gap-4">
          <div>
            <Label className="text-xs">{t('rebookCohort.termEnd', 'Einde huidige termijn')}</Label>
            <DateField value={termEndDate} onChange={setTermEndDate} />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.termEndHint', 'De week waarin de huidige termijn eindigt.')}
            </p>
          </div>
          <div>
            <Label className="text-xs">{t('rebookCohort.newStart', 'Start nieuwe ronde')}</Label>
            <DateField value={newStartDate} onChange={setNewStartDate} />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.newStartHint', 'Wanneer de volgende termijn begint.')}
            </p>
          </div>
          <div>
            <Label className="text-xs">{t('rebookCohort.newEnd', 'Einde nieuwe ronde')}</Label>
            <DateField value={newEndDate} onChange={setNewEndDate} />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.newEndHint', 'Leeg = lengte van de vorige ronde. Vakantiedagen worden niet ingepland.')}
            </p>
          </div>
        </CardContent>
      </Card>

      {previewTrainers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('rebookCohort.trainersTitle', 'Welke trainers gaan door?')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="pb-1 text-sm text-muted-foreground">
              {t('rebookCohort.trainersHint', 'Vink trainers uit die niet doorgaan. Hun sessies worden niet opnieuw geboekt; in de volgende stap kies je of hun spelers andere vrijgekomen plekken mogen boeken.')}
            </p>
            {previewTrainers.map((tr) => (
              <label key={tr.id} className="flex items-center gap-3 rounded p-2 hover:bg-muted cursor-pointer">
                <Checkbox checked={trainerIncluded(tr.keys)} onCheckedChange={(v) => toggleTrainer(tr.keys, Boolean(v))} />
                <span className="text-sm font-medium">{tr.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('rebookCohort.trainerGroups', '{{n}} groep(en)', { n: tr.keys.length })}
                </span>
              </label>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.priceTitle', 'Prijs per sessie')}</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('rebookCohort.sessionPrice', 'Prijs per sessie (€)')}</Label>
              {preview?.pricesIncludeVat != null && (
                <span className="text-xs text-muted-foreground">
                  {preview.pricesIncludeVat ? t('rebookCohort.vatIncl', 'incl. btw') : t('rebookCohort.vatExcl', 'excl. btw')}
                </span>
              )}
            </div>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={sessionPrice}
              onChange={(e) => setSessionPrice(e.target.value)}
              placeholder={preview?.suggestedPrice != null ? String(preview.suggestedPrice) : '0.00'}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.sessionPriceHint', 'Prijs voor elke sessie in de nieuwe ronde.')}
            </p>
          </div>
        </CardContent>
      </Card>

      <HolidayRangeEditor holidays={holidays} onChange={setHolidays} />

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.targetName', 'Naam nieuwe ronde')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={targetCycleName}
            onChange={(e) => setTargetCycleName(e.target.value)}
            placeholder={t('rebookCohort.targetNamePlaceholder', 'bv. Najaar 2026')}
          />
        </CardContent>
      </Card>

      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
          <ChevronDown className={`h-4 w-4 mr-1 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          {t('rebookCohort.advanced', 'Geavanceerde opties')}
        </Button>
      </div>

      {showAdvanced && (
        <>
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

          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox checked={autoReminder} onCheckedChange={(v) => setAutoReminder(Boolean(v))} className="mt-0.5" />
            <div>
              <div className="text-sm font-medium">{t('rebookShared.autoReminder', 'Automatisch herinneren')}</div>
              <div className="text-xs text-muted-foreground">{t('rebookShared.autoReminderHint', 'Stuur spelers die nog niet reageerden automatisch een herinnering vlak voordat hun voorrang verloopt.')}</div>
            </div>
          </label>

          {autoReminder && (
            <div className="ml-7 space-y-3 rounded-md border p-3">
              <EmailSubjectField
                id="rebook-cohort-reminder-subject"
                value={reminderSubject}
                onChange={setReminderSubject}
                disabled={submitting}
                label={t('rebookShared.reminderSubjectLabel', 'Onderwerp van de herinnering')}
                placeholder={t('rebookShared.defaultReminderSubject', 'Herinnering: bevestig je plek')}
                variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
              <EmailMessageField
                id="rebook-cohort-reminder-message"
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

          <RebookPaymentModeField
            academyProfileId={academyProfileId}
            paymentMode={paymentMode}
            setPaymentMode={setPaymentMode}
            strictMollie={strictMollie}
            setStrictMollie={setStrictMollie}
          />

          <Card>
            <CardHeader>
              <CardTitle>{t('rebookCohort.publicRelease', 'Publiek vrijgeven')}</CardTitle>
            </CardHeader>
            <CardContent>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={requireAdminReview} onCheckedChange={(v) => setRequireAdminReview(Boolean(v))} />
                <div>
                  <div className="text-sm font-medium">{t('rebookCohort.requireReview', 'Mijn goedkeuring vereist voordat het publiek wordt')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('rebookCohort.requireReviewHint', 'De plekken blijven verborgen totdat je ze zelf vrijgeeft.')}
                  </div>
                </div>
              </label>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex justify-end">
        <Button onClick={prepareConfirm} disabled={submitting || previewing || preparing || !preview || preview.players <= 0}>
          {preparing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ChevronRight className="h-4 w-4 mr-2" />}
          {preparing ? t('common:loading', 'Bezig...') : t('rebookCohort.toReview', 'Volgende: controleren')}
        </Button>
      </div>
    </div>
  );
}
