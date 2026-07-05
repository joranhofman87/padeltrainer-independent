import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, parse } from 'date-fns';
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
  const [weeks, setWeeks] = useState('');
  const [sessionPrice, setSessionPrice] = useState('');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [strictMollie, setStrictMollie] = useState(false);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
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
  const [invitationMessage, setInvitationMessage] = useState('');
  const [invitationSubject, setInvitationSubject] = useState('');
  const [rebookRules, setRebookRules] = useState('');

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
      weeks: weeks ? Number(weeks) : 0,
      sessionPrice: sessionPrice === '' ? null : Number(sessionPrice),
      holidays: holidays.filter((h) => h.from && h.to),
      invitationMessage: invitationMessage.trim() || null,
      invitationSubject: invitationSubject.trim() || null,
      rebookRules: normalizeRichTextHtml(rebookRules),
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
      targetCycleName,
      weeks,
      sessionPrice,
      holidays,
      invitationMessage,
      invitationSubject,
      rebookRules,
    ],
  );

  const inputsValid = selectedLocationIds.size > 0 && Boolean(termEndDate) && Boolean(newStartDate);

  // Auto-count the cohort the moment location + both dates are set, shown up top —
  // no manual "preview" click. The headcount/groups depend only on the cohort inputs
  // (location + dates), so re-run only when those change (not on weeks/price typing).
  const locKey = useMemo(() => [...selectedLocationIds].sort().join(','), [selectedLocationIds]);
  useEffect(() => {
    if (!(selectedLocationIds.size > 0 && termEndDate && newStartDate)) { setPreview(null); return; }
    let cancelled = false;
    setPreviewing(true);
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
        // Pre-fill weeks + price from the previous term when the user hasn't set them.
        setWeeks((w) => (w ? w : (result.suggestedWeeks > 0 ? String(result.suggestedWeeks) : w)));
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
            {t('rebookCohort.confirmIntro', 'Je maakt "{{name}}" aan vanaf {{date}} ({{weeks}} weken, € {{price}} per sessie). Dit nodigt de volgende spelers nu per e-mail uit:', {
              name: targetCycleName.trim() || t('rebookCohort.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
              date: newStartDate ? format(parse(newStartDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : newStartDate,
              weeks: confirmData.effWeeks ?? '',
              price: sessionPrice || (preview?.suggestedPrice ?? ''),
            })}
          </p>
        </div>
        <RebookReviewTable
          groups={confirmData.groupsDetail}
          noEmailTotal={confirmData.noEmailTotal}
          grandInvoiceTotal={confirmData.grandInvoiceTotal}
          locationName={(id) => locations.find((l) => l.id === id)?.name}
          ackNoEmail={ackNoEmail}
          onAckChange={setAckNoEmail}
        />
        <p className="text-sm font-medium">
          {t('rebookCohort.confirmEmails', '{{players}} spelers krijgen nu een uitnodiging per e-mail.', { players: emailCount })}
        </p>
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
                  <span className="text-muted-foreground"> {t('rebookCohort.cohortWeeks', '± {{count}} weken per groep.', { count: weeks ? Number(weeks) : preview.suggestedWeeks })}</span>
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
        <CardContent className="grid sm:grid-cols-2 gap-4">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.sessionsAndPrice', 'Aantal weken en prijs')}</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">{t('rebookCohort.weeks', 'Aantal weken')}</Label>
            <Input
              type="number"
              min={1}
              max={52}
              value={weeks}
              onChange={(e) => setWeeks(e.target.value)}
              placeholder={preview?.suggestedWeeks ? String(preview.suggestedWeeks) : ''}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.weeksHint', 'Hoeveel weken de nieuwe ronde loopt. Vakantieweken worden overgeslagen.')}
            </p>
          </div>
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
          />

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
