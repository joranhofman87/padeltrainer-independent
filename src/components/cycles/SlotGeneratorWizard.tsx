import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, CalendarPlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DateInputField } from '@/components/ui/date-input-field';
import { formatDate } from '@/lib/format';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { WeekdayToggle } from './WeekdayToggle';
import { HolidayRangeEditor, type HolidayRange } from './HolidayRangeEditor';
import { SlotLocationPicker, type SlotLocation } from '@/components/slots/SlotLocationPicker';
import { planSlots, type SlotDraft, type SlotPlanConfig, type Weekday } from '@/lib/slotPlan';
import { generateCycleWithSlots, type GenerateCycleInput } from '@/lib/slotGenerator';

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
  timezone?: string;
  /** Test/override seam for the create-lib (defaults to the real one). */
  generate?: typeof generateCycleWithSlots;
}

const TIME_OPTIONS: string[] = [];
for (let h = 6; h <= 23; h++) {
  TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:00`);
  TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:30`);
}
const DURATIONS = [30, 45, 60, 90, 120];

export function SlotGeneratorWizard({
  ownerType,
  ownerId,
  backHref,
  trainerSelection,
  availableLocations,
  timezone = 'Europe/Amsterdam',
  generate = generateCycleWithSlots,
}: SlotGeneratorWizardProps) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();

  const [step, setStep] = useState<'configure' | 'preview'>('configure');
  const [cycleName, setCycleName] = useState('');
  const [pickedTrainerId, setPickedTrainerId] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('4');
  const [startDate, setStartDate] = useState('');
  const [weeks, setWeeks] = useState('5');
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);
  const [windowStart, setWindowStart] = useState('15:00');
  const [windowEnd, setWindowEnd] = useState('20:00');
  const [durationMin, setDurationMin] = useState(60);
  const [hasBreak, setHasBreak] = useState(false);
  const [breakStart, setBreakStart] = useState('17:00');
  const [breakEnd, setBreakEnd] = useState('18:00');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);
  // 'cycle' = whole cycle only (allow_single_booking=false). 'both' = whole cycle OR single sessions
  // (allow_single_booking=true → BookLesson always shows the cycle bundle AND offers each session
  // individually). There is no single-only mode — the cycle bundle is always shown for a full cycle.
  const [bookingMode, setBookingMode] = useState<'both' | 'cycle'>('cycle');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [requiresUpfront, setRequiresUpfront] = useState(false);

  const [preview, setPreview] = useState<SlotDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const trainerId = trainerSelection.mode === 'self' ? trainerSelection.trainerId : pickedTrainerId;

  const buildPlan = (): SlotPlanConfig => ({
    weekdays,
    windowStart,
    windowEnd,
    slotDurationMin: durationMin,
    ...(hasBreak ? { breakStart, breakEnd } : {}),
    startDate,
    weeks: Number(weeks),
    holidayRanges: holidays.filter((h) => h.from && h.to),
    timezone,
  });

  const handlePreview = () => {
    if (!cycleName.trim()) return toast.error(t('slotGenerator.errNoName', 'Geef de cyclus een naam.'));
    if (!trainerId) return toast.error(t('slotGenerator.errNoTrainer', 'Kies een trainer.'));
    if (!startDate) return toast.error(t('slotGenerator.errNoStart', 'Kies een startdatum.'));
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
        allowSingleBooking: bookingMode === 'both',
        publishVisibility: visibility,
        requiresUpfrontPayment: visibility === 'public' && requiresUpfront,
        plan: buildPlan(),
      };
      const res = await generate(input);
      toast.success(
        t('slotGenerator.created', '{{count}} sessies aangemaakt als concept.', { count: res.slotsCreated }),
      );
      navigate(backHref);
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('slotGenerator.errGeneric', 'Er ging iets mis. Probeer het opnieuw.')));
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

            <SlotLocationPicker
              value={locationId}
              onChange={setLocationId}
              trainerId={trainerId || null}
              availableLocations={availableLocations}
            />

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
                <Label htmlFor="sg-weeks">{t('slotGenerator.weeks', 'Aantal weken')}</Label>
                <Input id="sg-weeks" type="number" min="1" max="52" value={weeks} onChange={(e) => setWeeks(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t('slotGenerator.weekdays', 'Op welke dagen?')}</Label>
              <WeekdayToggle value={weekdays} onChange={setWeekdays} />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.windowStart', 'Begintijd')}</Label>
                <Select value={windowStart} onValueChange={setWindowStart}>
                  <SelectTrigger aria-label={t('slotGenerator.windowStart', 'Begintijd')}><SelectValue /></SelectTrigger>
                  <SelectContent>{TIME_OPTIONS.map((tm) => <SelectItem key={tm} value={tm}>{tm}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.windowEnd', 'Eindtijd')}</Label>
                <Select value={windowEnd} onValueChange={setWindowEnd}>
                  <SelectTrigger aria-label={t('slotGenerator.windowEnd', 'Eindtijd')}><SelectValue /></SelectTrigger>
                  <SelectContent>{TIME_OPTIONS.map((tm) => <SelectItem key={tm} value={tm}>{tm}</SelectItem>)}</SelectContent>
                </Select>
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
                    <Select value={breakStart} onValueChange={setBreakStart}>
                      <SelectTrigger aria-label={t('slotGenerator.breakStart', 'Pauze van')}><SelectValue /></SelectTrigger>
                      <SelectContent>{TIME_OPTIONS.map((tm) => <SelectItem key={tm} value={tm}>{tm}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('slotGenerator.breakEnd', 'Pauze tot')}</Label>
                    <Select value={breakEnd} onValueChange={setBreakEnd}>
                      <SelectTrigger aria-label={t('slotGenerator.breakEnd', 'Pauze tot')}><SelectValue /></SelectTrigger>
                      <SelectContent>{TIME_OPTIONS.map((tm) => <SelectItem key={tm} value={tm}>{tm}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            <HolidayRangeEditor holidays={holidays} onChange={setHolidays} />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t('slotGenerator.bookingMode', 'Boeken')}</Label>
                <Select value={bookingMode} onValueChange={(v) => setBookingMode(v as 'both' | 'cycle')}>
                  <SelectTrigger aria-label={t('slotGenerator.bookingMode', 'Boeken')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cycle">{t('slotGenerator.bookingCycle', 'Alleen hele cyclus')}</SelectItem>
                    <SelectItem value="both">{t('slotGenerator.bookingBoth', 'Hele cyclus óf losse sessies')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('slotGenerator.bookingModeHelp', 'Bij “óf losse sessies” kiest de speler zelf bij het boeken: de hele cyclus of losse sessies.')}
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
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('slotGenerator.reviewTitle', '{{count}} sessies worden aangemaakt', { count: preview.length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('slotGenerator.reviewHint', 'Deze worden als CONCEPT aangemaakt (nog niet boekbaar). Je publiceert ze daarna vanuit de cyclus.')}
            </p>
            <div className="max-h-80 overflow-y-auto rounded-md border divide-y">
              {preview.map((s) => (
                <div key={s.startISO} className="flex justify-between px-3 py-2 text-sm">
                  <span>{formatDate(s.startISO, 'EEE d MMM')}</span>
                  <span className="text-muted-foreground">
                    {formatDate(s.startISO, 'HH:mm')} – {formatDate(s.endISO, 'HH:mm')}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep('configure')} disabled={submitting}>
                <ArrowLeft className="mr-2 h-4 w-4" />{t('slotGenerator.adjust', 'Aanpassen')}
              </Button>
              <Button onClick={handleGenerate} disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CalendarPlus className="mr-2 h-4 w-4" />}
                {t('slotGenerator.generate', 'Genereer als concept')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
