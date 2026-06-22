import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { format, startOfDay } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, CalendarIcon, ChevronDown, Plus, Send, Trash2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatDate } from '@/lib/format';
import { getCycles, type Cycle } from '@/lib/cycles';
import { fetchCyclusLabels, buildCyclusLabel, type CyclusRosterEntry } from '@/lib/cyclusLabel';
import type { RebookPaymentMode } from '@/lib/priorityClaims';

interface Props {
  academyProfileId: string;
  backHref: string;
}

interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

interface GroupDetail {
  weekday: string;
  time: string;
  players: number;
  sessions: number;
}

// Review summary returned by the dryRun before anything is created/emailed.
interface ReviewData {
  groups: number;
  players: number;
  totalSessions: number;
  effWeeks: number;
  suggestedPrice: number | null;
  groupsDetail: GroupDetail[];
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
  const [weeks, setWeeks] = useState('');
  const [sessionPrice, setSessionPrice] = useState('');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);
  const [targetCycleName, setTargetCycleName] = useState(
    t('newRound.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
  );

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [review, setReview] = useState<ReviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
  const inputsValid = Boolean(sourceCyclusId) && Boolean(newStartDate);

  const baseBody = useMemo(
    () => ({
      sourceCyclusId,
      newStartDate,
      priorityWindowDays,
      memberWindowDays: enableMemberWindow ? memberWindowDays : 0,
      paymentMode,
      requireAdminReview,
      targetCycleName: targetCycleName.trim(),
      weeks: weeks ? Number(weeks) : 0,
      sessionPrice: sessionPrice === '' ? null : Number(sessionPrice),
      holidays: holidays.filter((h) => h.from && h.to),
    }),
    [sourceCyclusId, newStartDate, priorityWindowDays, enableMemberWindow, memberWindowDays, paymentMode, requireAdminReview, targetCycleName, weeks, sessionPrice, holidays],
  );

  const addHoliday = () => setHolidays((prev) => [...prev, { name: '', from: '', to: '' }]);
  const updateHoliday = (i: number, patch: Partial<HolidayRange>) =>
    setHolidays((prev) => prev.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  const removeHoliday = (i: number) => setHolidays((prev) => prev.filter((_, idx) => idx !== i));

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
      // Pre-fill weeks + price from the previous round when the user left them blank.
      const suggestedWeeks = Number(data?.suggestedWeeks ?? 0);
      const suggestedPrice = data?.suggestedPrice == null ? null : Number(data.suggestedPrice);
      if (!weeks && suggestedWeeks > 0) setWeeks(String(suggestedWeeks));
      if (sessionPrice === '' && suggestedPrice != null) setSessionPrice(String(suggestedPrice));
      setReview({
        groups: Number(data?.groups ?? 0),
        players,
        totalSessions: Number(data?.totalSessions ?? 0),
        effWeeks: Number(data?.effWeeks ?? 0),
        suggestedPrice,
        groupsDetail: Array.isArray(data?.groupsDetail) ? (data.groupsDetail as GroupDetail[]) : [],
      });
      setStep('review');
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('newRound.errPreview', 'Kon de preview niet ophalen. Probeer het opnieuw.')));
    } finally {
      setPreviewing(false);
    }
  };

  // Step 2: actually create the round + send invitations.
  const handleSubmit = async () => {
    if (!inputsValid || !review || review.players <= 0 || submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', { body: baseBody });
      if (error) throw error;
      if (data?.ok === false && data?.reason === 'already_exists') {
        toast.error(t('newRound.alreadyExists', 'Er bestaat al een ronde met deze naam en startdatum. Geef de nieuwe ronde een andere naam of datum.'));
        return;
      }
      toast.success(
        t('newRound.success', '{{groups}} groep(en) · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
          groups: Number(data?.groups ?? 0),
          players: Number(data?.players ?? 0),
          invites: Number(data?.invitesSent ?? 0),
        }),
      );
      navigate(backHref);
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('newRound.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
    } finally {
      setSubmitting(false);
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
            <CardHeader><CardTitle>{t('newRound.whenAndHowMany', 'Wanneer en hoeveel weken?')}</CardTitle></CardHeader>
            <CardContent className="grid sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.startDate', 'Startdatum')}</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn('w-full justify-start text-left font-normal', !startDate && 'text-muted-foreground')}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {startDate ? formatDate(startDate, 'PPP') : t('newRound.pickDate', 'Kies een datum')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={(d) => { if (d) { setStartDate(startOfDay(d)); setReview(null); } }}
                      disabled={(date) => date < startOfDay(new Date())}
                      initialFocus
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.weeks', 'Aantal weken')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={52}
                  value={weeks}
                  onChange={(e) => setWeeks(e.target.value)}
                  placeholder={t('newRound.weeksPlaceholder', 'bv. 10')}
                />
                <p className="text-xs text-muted-foreground">{t('newRound.weeksHint', 'Vakantieweken worden overgeslagen.')}</p>
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

          <Card>
            <CardHeader><CardTitle>{t('newRound.holidays', 'Vakanties (geen training)')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('newRound.holidaysHint', 'Geef vakantieperiodes op. Op deze dagen wordt niets ingepland.')}
              </p>
              {holidays.map((h, i) => (
                <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                  <div>
                    <Label className="text-xs">{t('newRound.holidayName', 'Naam')}</Label>
                    <Input value={h.name} onChange={(e) => updateHoliday(i, { name: e.target.value })} placeholder={t('newRound.holidayNamePlaceholder', 'bv. Herfstvakantie')} />
                  </div>
                  <div>
                    <Label className="text-xs">{t('newRound.holidayFrom', 'Van')}</Label>
                    <Input type="date" value={h.from} onChange={(e) => updateHoliday(i, { from: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">{t('newRound.holidayTo', 'Tot en met')}</Label>
                    <Input type="date" value={h.to} onChange={(e) => updateHoliday(i, { to: e.target.value })} />
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => removeHoliday(i)} aria-label={t('newRound.removeHoliday', 'Verwijderen')}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addHoliday}>
                <Plus className="h-4 w-4 mr-1" /> {t('newRound.addHoliday', 'Vakantie toevoegen')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('newRound.targetName', 'Naam nieuwe ronde')}</CardTitle></CardHeader>
            <CardContent>
              <Input value={targetCycleName} onChange={(e) => setTargetCycleName(e.target.value)} placeholder={t('newRound.targetNamePlaceholder', 'bv. Najaar 2026')} />
            </CardContent>
          </Card>

          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
              <ChevronDown className={`h-4 w-4 mr-1 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              {t('newRound.advanced', 'Geavanceerde opties')}
            </Button>
          </div>

          {showAdvanced && (
            <>
              <Card>
                <CardHeader><CardTitle>{t('newRound.windows', 'Voorrang en ledenvenster')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="max-w-xs">
                    <Label>{t('newRound.priorityDays', 'Hoeveel dagen krijgen spelers voorrang?')}</Label>
                    <Input type="number" min={1} max={60} value={priorityWindowDays} onChange={(e) => setPriorityWindowDays(Number(e.target.value))} />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('newRound.priorityHint', 'De plek blijft gereserveerd totdat de speler nee zegt of deze periode voorbij is.')}
                    </p>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <Checkbox checked={enableMemberWindow} onCheckedChange={(v) => setEnableMemberWindow(Boolean(v))} />
                    <span className="text-sm">{t('newRound.enableMemberWindow', 'Geef spelers uit de vorige ronde eerder toegang dan het publiek')}</span>
                  </label>
                  {enableMemberWindow && (
                    <div className="max-w-xs">
                      <Label>{t('newRound.memberDays', 'Lengte ledenvenster (dagen)')}</Label>
                      <Input type="number" min={1} max={60} value={memberWindowDays} onChange={(e) => setMemberWindowDays(Number(e.target.value))} />
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('newRound.memberHint', 'Na het voorrangsvenster kunnen alleen spelers uit de vorige ronde nog boeken of wisselen.')}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>{t('newRound.payment', 'Betaling')}</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  <Label>{t('bulkCopy.paymentModeLabel', 'How do players pay when they keep their spot?')}</Label>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" className="mt-1" checked={paymentMode === 'deferred_split'} onChange={() => setPaymentMode('deferred_split')} />
                    <span>{t('bulkCopy.paymentModeDeferred', 'Invoice at cycle start — the price is split between everyone who joins')}</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input type="radio" className="mt-1" checked={paymentMode === 'upfront'} onChange={() => setPaymentMode('upfront')} />
                    <span>{t('bulkCopy.paymentModeUpfront', 'Pay immediately — the player checks out online when they say yes')}</span>
                  </label>
                  {paymentMode === 'upfront' && (
                    <p className="text-xs text-muted-foreground pl-6">
                      {t('bulkCopy.paymentModeUpfrontHint', 'Requires online payments (Mollie) for the trainer or academy.')}
                    </p>
                  )}
                </CardContent>
              </Card>

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
            </>
          )}

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
                {t('newRound.reviewIntro', 'Je maakt "{{name}}" aan vanaf {{date}} ({{weeks}} weken, € {{price}} per sessie):', {
                  name: targetCycleName.trim() || t('newRound.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
                  date: newStartDate,
                  weeks: review.effWeeks,
                  price: effPrice || '—',
                })}
              </p>
              <ul className="border rounded-md divide-y">
                {review.groupsDetail.map((g, i) => (
                  <li key={i} className="flex items-center justify-between px-3 py-2">
                    <span className="font-medium capitalize">{g.weekday} {g.time}</span>
                    <span className="text-muted-foreground">
                      {t('newRound.reviewGroupLine', '{{players}} spelers · {{sessions}} sessies', { players: g.players, sessions: g.sessions })}
                    </span>
                  </li>
                ))}
              </ul>
              {holidays.filter((h) => h.from && h.to).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('newRound.reviewHolidays', 'Vakanties overgeslagen: {{names}}', {
                    names: holidays.filter((h) => h.from && h.to).map((h) => h.name || `${h.from}–${h.to}`).join(', '),
                  })}
                </p>
              )}
              <p className="font-medium">
                {t('newRound.reviewEmails', '{{players}} spelers krijgen nu een uitnodiging per e-mail.', { players: review.players })}
              </p>
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('configure')} disabled={submitting}>
              <ArrowLeft className="h-4 w-4 mr-2" /> {t('newRound.backToConfigure', 'Aanpassen')}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              <Send className="h-4 w-4 mr-2" />
              {submitting ? t('common:saving', 'Bezig...') : t('newRound.confirmSend', 'Aanmaken & spelers uitnodigen')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
