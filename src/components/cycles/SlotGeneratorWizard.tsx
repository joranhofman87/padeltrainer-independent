import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, CalendarPlus, Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TimeSelect } from '@/components/ui/time-select';
import { DateInputField } from '@/components/ui/date-input-field';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { buildHalfHourOptions } from '@/lib/timeOptions';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { isTrainerSlotOverlapError } from '@/lib/slotConflicts';
import { WeekdayToggle } from './WeekdayToggle';
import { HolidayRangeEditor, type HolidayRange } from './HolidayRangeEditor';
import { SlotLocationPicker, type SlotLocation } from '@/components/slots/SlotLocationPicker';
import { planSlots, groupSlotsBySeries, type SlotDraft, type SlotPlanConfig, type Weekday } from '@/lib/slotPlan';
import { generateCycleWithSlots, type GenerateCycleInput } from '@/lib/slotGenerator';
import type { CycleBookingMode } from '@/lib/cycleBookingMode';

export interface SlotGeneratorTrainer {
  id: string;
  name: string;
}

export interface SlotGeneratorWizardProps {
  ownerType: 'trainer' | 'academy';
  ownerId: string;
  backHref: string;
  /** Trainer model — injected, never derived from `ownerType` inside the component. */
  trainerSelection: { mode: 'self'; trainerId: string } | { mode: 'pick'; trainers: SlotGeneratorTrainer[] };
  availableLocations?: SlotLocation[];
  /** Where "add a location first" links to when the owner has none yet (academy: its locations page). */
  manageLocationsHref?: string;
  timezone?: string;
  /** Test/override seam for the create-lib (defaults to the real one). */
  generate?: typeof generateCycleWithSlots;
}

const TIME_OPTIONS = buildHalfHourOptions(6, 23);
const DURATIONS = [30, 45, 60, 90, 120];

export function SlotGeneratorWizard({
  ownerType,
  ownerId,
  backHref,
  trainerSelection,
  availableLocations,
  manageLocationsHref,
  timezone = 'Europe/Amsterdam',
  generate = generateCycleWithSlots,
}: SlotGeneratorWizardProps) {
  const { t, i18n } = useTranslation('cycles');
  const navigate = useNavigate();

  const [step, setStep] = useState<'configure' | 'preview' | 'done'>('configure');
  const [createdCycleIds, setCreatedCycleIds] = useState<string[]>([]);
  const [cycleName, setCycleName] = useState('');
  const [pickedTrainerId, setPickedTrainerId] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('4');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [windowStart, setWindowStart] = useState('15:00');
  const [windowEnd, setWindowEnd] = useState('20:00');
  const [durationMin, setDurationMin] = useState(60);
  const [hasBreak, setHasBreak] = useState(false);
  const [breakStart, setBreakStart] = useState('17:00');
  const [breakEnd, setBreakEnd] = useState('18:00');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);
  // The full 4-mode booking taxonomy, identical to the bulk "Boekbaarheid" action
  // (cycleBookingMode): whole cycle only / cycle or sessions / sessions per seat /
  // sessions as the whole court. Same trainer-ns copy as the bulk dialog.
  const [bookingMode, setBookingMode] = useState<CycleBookingMode>('cyclus_only');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [requiresUpfront, setRequiresUpfront] = useState(false);

  const [preview, setPreview] = useState<SlotDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const trainerId = trainerSelection.mode === 'self' ? trainerSelection.trainerId : pickedTrainerId;

  // Location is a required field for an academy (its sessions are always at a venue). The trainer
  // path keeps it optional (some independents don't track locations). `noLocations` is the academy
  // "you haven't added a location yet" case — availableLocations is passed as an (empty) array there;
  // the trainer path passes it undefined and the picker self-fetches.
  const locationRequired = ownerType === 'academy';
  const noLocations = Array.isArray(availableLocations) && availableLocations.length === 0;

  // The preview is grouped into the same per-(weekday+time) series the generator will create one
  // cyclus from each — so the review step shows exactly the cycli that will be made.
  const previewSeries = useMemo(
    () => groupSlotsBySeries(preview, timezone, i18n.language),
    [preview, timezone, i18n.language],
  );
  // Render preview rows in the OWNER's timezone (not the browser's) so they always match the
  // timezone-anchored series label above them.
  const tzDate = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }),
    [i18n.language, timezone],
  );
  const tzTime = useMemo(
    () => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }),
    [timezone],
  );

  const buildPlan = (): SlotPlanConfig => ({
    weekdays,
    windowStart,
    windowEnd,
    slotDurationMin: durationMin,
    ...(hasBreak ? { breakStart, breakEnd } : {}),
    startDate,
    endDate: endDate ? format(endDate, 'yyyy-MM-dd') : '',
    holidayRanges: holidays.filter((h) => h.from && h.to),
    timezone,
  });

  const handlePreview = () => {
    if (!cycleName.trim()) return toast.error(t('slotGenerator.errNoName', 'Geef de cyclus een naam.'));
    if (!trainerId) return toast.error(t('slotGenerator.errNoTrainer', 'Kies een trainer.'));
    if (locationRequired && !locationId) return toast.error(t('slotGenerator.errNoLocation', 'Kies een locatie.'));
    if (!startDate) return toast.error(t('slotGenerator.errNoStart', 'Kies een startdatum.'));
    if (!endDate) return toast.error(t('slotGenerator.errNoEnd', 'Kies een einddatum.'));
    if (format(endDate, 'yyyy-MM-dd') < startDate) {
      return toast.error(t('slotGenerator.errEndBeforeStart', 'De einddatum moet op of na de startdatum liggen.'));
    }
    if (weekdays.length === 0) return toast.error(t('slotGenerator.errNoDays', 'Kies minstens één dag.'));
    if (!(Number(price) > 0)) return toast.error(t('slotGenerator.errNoPrice', 'Vul een prijs per sessie in.'));
    try {
      const slots = planSlots(buildPlan());
      if (slots.length === 0) {
        return toast.error(t('slotGenerator.errNoSlots', 'Deze instellingen leveren geen sessies op.'));
      }
      setPreview(slots);
      setStep('preview');
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('slotGenerator.errGeneric', 'Er ging iets mis. Probeer het opnieuw.')));
    }
  };

  const handleGenerate = async () => {
    setSubmitting(true);
    try {
      const input: GenerateCycleInput = {
        ownerType,
        ownerId,
        cycleName: cycleName.trim(),
        trainerId,
        academyProfileId: ownerType === 'academy' ? ownerId : null,
        locationId,
        pricePerSession: Number(price),
        maxParticipants: maxParticipants ? Number(maxParticipants) : null,
        allowSingleBooking: bookingMode === 'both' || bookingMode === 'single_only',
        wholeSlotBooking: bookingMode === 'single_only_whole_slot',
        allowCyclusBooking: bookingMode === 'both' || bookingMode === 'cyclus_only',
        publishVisibility: visibility,
        requiresUpfrontPayment: visibility === 'public' && requiresUpfront,
        plan: buildPlan(),
        locale: i18n.language,
      };
      const res = await generate(input);
      // The generator silently drops planned sessions that would double-book the
      // trainer — say so, or a re-run looks like it generated the full preview.
      if (res.skippedOverlaps > 0) {
        toast.info(
          t('slotGenerator.skippedOverlaps', '{{count}} sessie(s) overgeslagen — de trainer heeft op die tijden al een sessie.', {
            count: res.skippedOverlaps,
          }),
        );
      }
      setCreatedCycleIds(res.cycleIds);
      setStep('done');
    } catch (e) {
      toast.error(
        isTrainerSlotOverlapError(e)
          ? t('slotConflict.trainerOverlap', { ns: 'common' })
          : getFriendlyErrorMessage(e, t('slotGenerator.errGeneric', 'Er ging iets mis. Probeer het opnieuw.')),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className={step === 'configure' ? 'font-semibold text-foreground' : ''}>
          1. {t('slotGenerator.stepConfigure', 'Instellen')}
        </span>
        <ArrowRight className="h-3 w-3" />
        <span className={step === 'preview' ? 'font-semibold text-foreground' : ''}>
          2. {t('slotGenerator.stepReview', 'Controleren')}
        </span>
      </div>

      {step === 'configure' ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('slotGenerator.title', 'Snel sessies genereren')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sg-name">{t('slotGenerator.name', 'Naam')}</Label>
                <Input id="sg-name" value={cycleName} onChange={(e) => setCycleName(e.target.value)} />
              </div>
              {trainerSelection.mode === 'pick' && (
                <div className="space-y-1.5">
                  <Label>{t('slotGenerator.trainer', 'Trainer')}</Label>
                  <Select value={pickedTrainerId} onValueChange={setPickedTrainerId}>
                    <SelectTrigger aria-label={t('slotGenerator.trainer', 'Trainer')}>
                      <SelectValue placeholder={t('slotGenerator.trainer', 'Trainer')} />
                    </SelectTrigger>
                    <SelectContent>
                      {trainerSelection.trainers.map((tr) => (
                        <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t('slotGenerator.location', 'Locatie')}</Label>
              {noLocations ? (
                // Academy with no locations yet: show the "add a location first" helper right here
                // (the field's place) instead of the picker, so the requirement is obvious inline.
                <div className="rounded-md border border-dashed px-3 py-2.5 text-sm">
                  <div className="flex items-start gap-2 text-muted-foreground">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1">
                      <p>{t('slotGenerator.noLocationsHelp', 'Voeg eerst een locatie toe voordat je sessies kunt plannen.')}</p>
                      {manageLocationsHref && (
                        <Button variant="link" size="sm" asChild className="h-auto p-0" aria-label={t('slotGenerator.addLocationCta', 'Naar locaties')}>
                          <Link to={manageLocationsHref}>{t('slotGenerator.addLocationCta', 'Naar locaties')}</Link>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <SlotLocationPicker
                  value={locationId}
                  onChange={setLocationId}
                  trainerId={trainerId || null}
                  availableLocations={availableLocations}
                />
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sg-price">{t('slotGenerator.price', 'Prijs per sessie (€)')}</Label>
                <Input id="sg-price" type="number" min="0" step="0.5" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sg-max">{t('slotGenerator.maxParticipants', 'Max. deelnemers')}</Label>
                <Input id="sg-max" type="number" min="1" value={maxParticipants} onChange={(e) => setMaxParticipants(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sg-start">{t('slotGenerator.startDate', 'Startdatum')}</Label>
                <DateInputField id="sg-start" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sg-end">{t('slotGenerator.endDate', 'Einddatum')}</Label>
                <DatePickerPopover
                  id="sg-end"
                  value={endDate}
                  onChange={setEndDate}
                  ariaLabel={t('slotGenerator.endDate', 'Einddatum')}
                  placeholder={t('slotGenerator.endDatePlaceholder', 'Kies einddatum')}
                  className="w-full"
                  disabled={(d) => (startDate ? format(d, 'yyyy-MM-dd') < startDate : false)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('slotGenerator.weekdays', 'Op welke dagen?')}</Label>
              <WeekdayToggle value={weekdays} onChange={setWeekdays} />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.windowStart', 'Begintijd')}</Label>
                <TimeSelect value={windowStart} onValueChange={setWindowStart} options={TIME_OPTIONS} ariaLabel={t('slotGenerator.windowStart', 'Begintijd')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.windowEnd', 'Eindtijd')}</Label>
                <TimeSelect value={windowEnd} onValueChange={setWindowEnd} options={TIME_OPTIONS} ariaLabel={t('slotGenerator.windowEnd', 'Eindtijd')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.duration', 'Duur (min)')}</Label>
                <Select value={String(durationMin)} onValueChange={(v) => setDurationMin(Number(v))}>
                  <SelectTrigger aria-label={t('slotGenerator.duration', 'Duur (min)')}><SelectValue /></SelectTrigger>
                  <SelectContent>{DURATIONS.map((d) => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox id="sg-break" checked={hasBreak} onCheckedChange={(c) => setHasBreak(c === true)} />
                <Label htmlFor="sg-break">{t('slotGenerator.hasBreak', 'Pauze tussendoor (overslaan)')}</Label>
              </div>
              {hasBreak && (
                <div className="grid gap-4 sm:grid-cols-2 pl-6">
                  <div className="space-y-1.5">
                    <Label>{t('slotGenerator.breakStart', 'Pauze van')}</Label>
                    <TimeSelect value={breakStart} onValueChange={setBreakStart} options={TIME_OPTIONS} ariaLabel={t('slotGenerator.breakStart', 'Pauze van')} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('slotGenerator.breakEnd', 'Pauze tot')}</Label>
                    <TimeSelect value={breakEnd} onValueChange={setBreakEnd} options={TIME_OPTIONS} ariaLabel={t('slotGenerator.breakEnd', 'Pauze tot')} />
                  </div>
                </div>
              )}
            </div>

            <HolidayRangeEditor holidays={holidays} onChange={setHolidays} />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.bookingMode', 'Boeken')}</Label>
                <Select value={bookingMode} onValueChange={(v) => setBookingMode(v as CycleBookingMode)}>
                  <SelectTrigger aria-label={t('slotGenerator.bookingMode', 'Boeken')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {([
                      ['cyclus_only', t('cyclesTab.bulkBooking.modeCyclusOnly', { ns: 'trainer' }), t('cyclesTab.bulkBooking.modeCyclusOnlyHelp', { ns: 'trainer' })],
                      ['both', t('cyclesTab.bulkBooking.modeBoth', { ns: 'trainer' }), t('cyclesTab.bulkBooking.modeBothHelp', { ns: 'trainer' })],
                      ['single_only', t('cyclesTab.bulkBooking.modeSingleOnly', { ns: 'trainer' }), t('cyclesTab.bulkBooking.modeSingleOnlyHelp', { ns: 'trainer' })],
                      ['single_only_whole_slot', t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlot', { ns: 'trainer' }), t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlotHelp', { ns: 'trainer' })],
                    ] as const).map(([value, label, help]) => (
                      <SelectItem key={value} value={value}>
                        <span className="block">{label}</span>
                        <span className="block text-xs text-muted-foreground">{help}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {bookingMode === 'cyclus_only' && t('cyclesTab.bulkBooking.modeCyclusOnlyHelp', { ns: 'trainer' })}
                  {bookingMode === 'both' && t('cyclesTab.bulkBooking.modeBothHelp', { ns: 'trainer' })}
                  {bookingMode === 'single_only' && t('cyclesTab.bulkBooking.modeSingleOnlyHelp', { ns: 'trainer' })}
                  {bookingMode === 'single_only_whole_slot' && t('cyclesTab.bulkBooking.modeSingleOnlyWholeSlotHelp', { ns: 'trainer' })}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.visibility', 'Zichtbaarheid')}</Label>
                <Select value={visibility} onValueChange={(v) => setVisibility(v as 'public' | 'private')}>
                  <SelectTrigger aria-label={t('slotGenerator.visibility', 'Zichtbaarheid')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">{t('slotGenerator.visPrivate', 'Privé')}</SelectItem>
                    <SelectItem value="public">{t('slotGenerator.visPublic', 'Openbaar')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {visibility === 'public' && (
              <div className="flex items-center gap-2">
                <Checkbox id="sg-upfront" checked={requiresUpfront} onCheckedChange={(c) => setRequiresUpfront(c === true)} />
                <Label htmlFor="sg-upfront">{t('slotGenerator.requiresUpfront', 'Vooraf betalen om te boeken')}</Label>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => navigate(backHref)}>
                <ArrowLeft className="mr-2 h-4 w-4" />{t('slotGenerator.back', 'Terug')}
              </Button>
              <Button onClick={handlePreview}>
                {t('slotGenerator.preview', 'Voorbeeld')}<ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : step === 'preview' ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('slotGenerator.reviewTitleCycles', '{{cycles}} cycli ({{count}} sessies)', {
                cycles: previewSeries.length,
                count: preview.length,
              })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {visibility === 'public'
                ? t('slotGenerator.reviewHintPublic', 'Elke dag + tijd wordt een aparte cyclus. Na aanmaken staan de sessies DIRECT openbaar en boekbaar.')
                : t('slotGenerator.reviewHintPrivate', 'Elke dag + tijd wordt een aparte cyclus. De sessies worden privé aangemaakt (alleen intern te boeken); je kunt ze later openbaar maken.')}
            </p>
            <div className="max-h-80 overflow-y-auto rounded-md border divide-y">
              {previewSeries.map((series) => (
                <div key={series.key} className="px-3 py-2">
                  <div className="flex items-center justify-between text-sm font-medium">
                    <span>{cycleName.trim() ? `${cycleName.trim()} – ${series.label}` : series.label}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('slotGenerator.seriesSessions', '{{count}} sessies', { count: series.slots.length })}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5 pl-2">
                    {series.slots.map((s) => (
                      <div key={s.startISO} className="flex justify-between text-xs text-muted-foreground">
                        <span>{tzDate.format(new Date(s.startISO))}</span>
                        <span>{tzTime.format(new Date(s.startISO))} – {tzTime.format(new Date(s.endISO))}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep('configure')} disabled={submitting}>
                <ArrowLeft className="mr-2 h-4 w-4" />{t('slotGenerator.adjust', 'Aanpassen')}
              </Button>
              <Button onClick={handleGenerate} disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarPlus className="mr-2 h-4 w-4" />}
                {t('slotGenerator.generateLive', 'Sessies aanmaken')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('slotGenerator.doneLiveTitle', '{{count}} cycli aangemaakt', { count: createdCycleIds.length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {visibility === 'public'
                ? t('slotGenerator.doneHintPublic', 'De sessies staan in je agenda en zijn direct openbaar boekbaar.')
                : t('slotGenerator.doneHintPrivate', 'De sessies staan privé in je agenda (alleen intern te boeken). Openbaar maken kan later per cyclus of in bulk.')}
            </p>
            <div className="flex justify-end">
              <Button onClick={() => navigate(backHref)}>
                {t('slotGenerator.doneToOverview', 'Naar overzicht')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
