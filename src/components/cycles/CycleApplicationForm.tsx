import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, CheckCircle2, CreditCard, Banknote, Info } from 'lucide-react';
import { formatCurrency } from '@/lib/format';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { createRequiredPhoneSchema } from '@/lib/validation';
import { buildGuestPlayerDbFields, prefillProfileNameFields } from '@/lib/profileName';
import { getTermsForCycleOwner } from '@/lib/terms';
import { logger } from '@/lib/logger';
import TermsAcceptance from '@/components/booking/TermsAcceptance';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateInputField } from '@/components/ui/date-input-field';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import DayAvailabilityPicker, { type DayAvailability } from './DayAvailabilityPicker';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabaseClient';
import { submitIntakeRequest, type Cycle, type TimeWindow, type EventPaymentMethod, type CyclusOption } from '@/lib/cycles';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface TrainerOption {
  id: string;
  name: string;
}

interface LocationOption {
  id: string;
  name: string;
}

interface CycleApplicationFormProps {
  cycle: Cycle;
  playerId: string;
  playerUserId: string;
  playerName: string;
  playerFirstName?: string | null;
  playerLastName?: string | null;
  playerEmail: string;
  playerPhone?: string;
  playerRating?: number;
  playerRatingSystem?: string;
  playerBirthDate?: string;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
  isGuest?: boolean;
  isWaitlist?: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
}

const STANDARD_LESSON_TYPES = ['private', 'duo', 'group3', 'group4', 'kids'] as const;
const DEFAULT_DURATIONS = [30, 45, 60, 90, 120] as const;

export default function CycleApplicationForm({
  cycle,
  playerId,
  playerUserId,
  playerName,
  playerFirstName,
  playerLastName,
  playerEmail,
  playerPhone,
  playerRating,
  playerRatingSystem = 'knltb',
  playerBirthDate,
  trainers = [],
  locations = [],
  isGuest = false,
  isWaitlist = false,
  onSuccess,
  onCancel,
}: CycleApplicationFormProps) {
  const { t, i18n } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [ratingSystems, setRatingSystems] = useState<{ code: string; name: string }[]>([]);
  const [cycleTerms, setCycleTerms] = useState<string | null>(null);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'online' | 'cash'>('online');
  const [selectedCyclusOption, setSelectedCyclusOption] = useState<CyclusOption | null>(null);
  const [selectedDurationWeeks, setSelectedDurationWeeks] = useState<number | null>(null);
  
  const isEvent = cycle.type === 'event';
  const eventPaymentMethods = (cycle.settings as any)?.payment_methods as EventPaymentMethod | undefined;
  const cyclusOptions = ((cycle.settings as any)?.cyclus_options as CyclusOption[] | undefined) || [];
  const hasCyclusOptions = cyclusOptions.length > 0;
  const durationOptions = ((cycle.settings as any)?.duration_options as number[] | undefined) || [];
  const hasDurationOptions = durationOptions.length > 0;
  const availableDurations = ((cycle.settings as any)?.available_duration_minutes as number[] | undefined) || [...DEFAULT_DURATIONS];
  const effectiveDurations = availableDurations.sort((a, b) => a - b);
  const cyclAvailableDays = (cycle.settings as any)?.available_days as DayAvailability | undefined;
  
  // Load rating systems
  useEffect(() => {
    async function loadRatingSystems() {
      const { data } = await supabase
        .from('rating_systems')
        .select('code, name')
        .eq('is_active', true)
        .order('display_order');
      if (data) setRatingSystems(data);
    }
    loadRatingSystems();
  }, []);

  // Load applicable terms for this cycle
  useEffect(() => {
    async function loadTerms() {
      setTermsLoading(true);
      try {
        const { terms } = await getTermsForCycleOwner(cycle.owner_id, cycle.owner_type);
        setCycleTerms(terms);
      } catch (e) {
        logger.error('Error loading cycle terms', e instanceof Error ? e : new Error(String(e)), { component: 'CycleApplicationForm' });
      } finally {
        setTermsLoading(false);
      }
    }
    loadTerms();
  }, [cycle.owner_id, cycle.owner_type]);

  const timeBlockSchema = z.object({
    start: z.string(),
    end: z.string(),
  });

  const availabilitySchema = isEvent 
    ? z.record(z.string(), z.array(timeBlockSchema)).optional().default({})
    : z.record(
        z.string(),
        z.array(timeBlockSchema)
      ).refine(val => Object.keys(val).length > 0, {
        message: t('application.form.noAvailability'),
      });

  const prefilledName = prefillProfileNameFields({
    first_name: playerFirstName,
    last_name: playerLastName,
    full_name: playerName,
  });

  const formSchema = z.object({
    first_name: z.string().trim().min(2, t('application.form.firstNameMin')),
    last_name: z.string().trim().min(2, t('application.form.lastNameMin')),
    email: z.string().email(t('application.form.emailInvalid')),
    // Phone is mandatory on every public sign-up (registrations AND events) — we need a
    // reachable number for the applicant. Same rule as the registration leg.
    phone: createRequiredPhoneSchema(
      t('application.form.validation.phoneInvalid'),
      t('application.form.validation.phoneRequired'),
    ),
    password: z.string().optional(),
    birth_date: z.string().min(1, t('application.form.birthDateRequired')),
    rating: z.coerce.number().optional(),
    rating_system: z.string(),
    lesson_types: isEvent ? z.array(z.string()).optional().default([]) : z.array(z.string()).min(1, t('application.form.lessonTypeRequired')),
    preferred_duration_minutes: z.coerce.number(),
    sessions_per_week: z.coerce.number().optional().default(1),
    group_notes: z.string().optional(),
    availability: availabilitySchema,
    preferred_trainer_id: z.string().optional(),
    location_id: z.string().optional(),
    notes: z.string().min(1, t('application.form.experienceRequired')),
    consent: z.boolean().refine(val => val === true, {
      message: t('application.form.consentRequired'),
    }),
  });

  type FormValues = z.infer<typeof formSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      first_name: prefilledName.first_name,
      last_name: prefilledName.last_name,
      email: playerEmail || '',
      phone: playerPhone || '',
      birth_date: playerBirthDate || '',
      
      rating: playerRating || undefined,
      rating_system: (cycle.settings as any)?.rating_system || playerRatingSystem,
      lesson_types: [] as string[],
      preferred_duration_minutes: availableDurations.length === 1 ? availableDurations[0] : (cycle.settings.default_duration_minutes || 60),
      sessions_per_week: 1,
      availability: cyclAvailableDays && Object.keys(cyclAvailableDays).length > 0 ? cyclAvailableDays : {},
      preferred_trainer_id: '',
      location_id: '',
      notes: '',
      group_notes: '',
      consent: false,
    },
  });

  const onSubmit = async (values: FormValues) => {
    if (isSubmitting) return;
    // A cycle that offers packages (e.g. Leden / Niet-leden) prices ONLY via the chosen
    // package: without one there is no amount to invoice and the duration is ambiguous.
    // Require the choice before submit so every registration is priced and dated correctly.
    if (hasCyclusOptions && !selectedCyclusOption) {
      toast.error(t('application.form.selectCyclusRequired', 'Kies een pakket om door te gaan.'));
      return;
    }
    setIsSubmitting(true);
    const nameFields = buildGuestPlayerDbFields(values.first_name, values.last_name);
    const fullName = nameFields.full_name;
    try {
      // Convert availability to TimeWindow[] format
      const timeWindows: TimeWindow[] = [];
      const preferredDays: string[] = [];
      
      Object.entries(values.availability).forEach(([day, blocks]) => {
        preferredDays.push(day);
        blocks.forEach(block => {
          timeWindows.push({
            day,
            start: block.start,
            end: block.end,
          });
        });
      });

      const waitlistPrefix = isWaitlist ? '[WACHTLIJST] ' : '';
      const combinedNotes = [values.notes, values.group_notes].filter(Boolean).join('\n\n');
      const notesWithFlag = combinedNotes ? `${waitlistPrefix}${combinedNotes}` : (waitlistPrefix || undefined);

      // A logged-in user can fill the form for someone else (a parent
      // registering their child). That submission must NOT be attributed to the
      // submitter's account: it previously overwrote the submitter's profile
      // name and linked the registrant's guest record to the submitter's
      // profile. Treat "form name differs from the account's profile name" as
      // registering someone else and route it through the guest edge function.
      const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const registeringForSelf =
        !isGuest && (!playerName || normalize(fullName) === normalize(playerName));

      // Online event registrations return a public pay URL we redirect to after
      // a successful submit (the existing PublicInvoicePay page → Mollie).
      let redirectPayUrl: string | null = null;

      if (isGuest || !registeringForSelf) {
        // Guest flow: edge function handles account creation + intake (+ invoice)
        const { data: result, error: fnError } = await supabase.functions.invoke('submit-guest-intake', {
          body: {
            email: values.email,
            firstName: values.first_name,
            lastName: values.last_name,
            fullName,
            phone: values.phone,
            birthDate: values.birth_date || null,
            rating: values.rating,
            ratingSystem: values.rating_system,
            cycleId: cycle.id,
            lessonTypes: values.lesson_types,
            preferredDays,
            preferredTimeWindows: timeWindows,
            preferredDurationMinutes: values.preferred_duration_minutes,
            sessionsPerWeek: values.sessions_per_week,
            preferredTrainerIds: values.preferred_trainer_id ? [values.preferred_trainer_id] : [],
            locationId: values.location_id || null,
            notes: notesWithFlag || undefined,
            consentGiven: values.consent,
            language: i18n.language,
            paymentMethod: selectedPaymentMethod,
            metadata: {
              ...(selectedCyclusOption ? { selected_cyclus_option: selectedCyclusOption } : {}),
              ...(selectedDurationWeeks ? { preferred_number_of_weeks: selectedDurationWeeks } : {}),
            },
          },
        });

        if (fnError) throw fnError;
        if (result?.error) throw new Error(result.error);
        redirectPayUrl = result?.payment?.payUrl ?? null;
      } else {
        // Logged-in user flow
        const createdIntake = await submitIntakeRequest({
          cycle_id: cycle.id,
          player_id: playerId,
          full_name: fullName,
          email: values.email,
          phone: values.phone,
          birth_date: values.birth_date || undefined,
          rating: values.rating,
          rating_system: values.rating_system,
          lesson_types: values.lesson_types,
          preferred_days: preferredDays,
          preferred_time_windows: timeWindows,
          preferred_duration_minutes: values.preferred_duration_minutes,
          sessions_per_week: values.sessions_per_week,
          preferred_trainer_ids: values.preferred_trainer_id ? [values.preferred_trainer_id] : [],
          location_id: values.location_id || undefined,
          notes: notesWithFlag || undefined,
          consent_given: values.consent,
          metadata: {
            ...(selectedCyclusOption ? { selected_cyclus_option: selectedCyclusOption } : {}),
            ...(selectedDurationWeeks ? { preferred_number_of_weeks: selectedDurationWeeks } : {}),
          },
        });

        // Update player profile if rating/phone/birth_date changed
        const profileUpdates: Record<string, any> = {};
        if (values.rating && values.rating !== playerRating) {
          profileUpdates.skill_rating = values.rating;
          profileUpdates.rating_system = values.rating_system;
        }
        if (values.phone && values.phone !== playerPhone) {
          profileUpdates.phone = values.phone;
        }
        if (values.birth_date && values.birth_date !== playerBirthDate) {
          profileUpdates.birth_date = values.birth_date;
        }
        profileUpdates.first_name = nameFields.first_name;
        profileUpdates.last_name = nameFields.last_name;
        profileUpdates.full_name = nameFields.full_name;
        if (Object.keys(profileUpdates).length > 0) {
          await supabase
            .from('profiles')
            .update(profileUpdates)
            .eq('user_id', playerUserId);
        }

        // Mint the payable invoice for a paid event registration (mirrors the
        // guest edge function). Non-blocking: a failure leaves the registration
        // saved and the player can still pay later from their dashboard.
        if (createdIntake?.id) {
          try {
            const { data: payRes } = await supabase.functions.invoke('create-registration-invoice', {
              body: { intakeRequestId: createdIntake.id, paymentMethod: selectedPaymentMethod, language: i18n.language },
            });
            redirectPayUrl = (payRes as { payUrl?: string | null })?.payUrl ?? null;
          } catch (payErr) {
            logger.error('Registration invoice minting failed', payErr as Error, { component: 'CycleApplicationForm' });
          }
        }
      }

      // Online: hand off to the existing pay page → Mollie (skip the thank-you screen).
      if (redirectPayUrl) {
        window.location.href = redirectPayUrl;
        return;
      }

      setIsSuccess(true);
      toast.success(t('application.success.title'));
      onSuccess?.();

      // Non-blocking Slack notification
      supabase.functions.invoke('slack-notify', {
        body: {
          event: 'new_registration',
          data: {
            name: fullName,
            email: values.email,
            cycle: cycle.name,
            lesson_types: values.lesson_types.join(', '),
            flow: isGuest ? 'guest' : 'logged_in',
          },
        },
      }).catch(() => {});
    } catch (error: any) {
      logger.error('Error submitting application', error instanceof Error ? error : new Error(String(error)), { component: 'CycleApplicationForm' });
      toast.error(getFriendlyErrorMessage(error, t('application.form.submitError')));

      // Non-blocking Slack error alert
      supabase.functions.invoke('slack-notify', {
        body: {
          event: 'registration_error',
          data: {
            cycle: cycle.name,
            error: error?.message || 'Unknown error',
            flow: isGuest ? 'guest' : 'logged_in',
          },
        },
      }).catch(() => {});
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <Card className="border-primary/20">
        <CardContent className="pt-6">
          <div className="text-center space-y-4">
            <CheckCircle2 className="h-16 w-16 text-primary mx-auto" />
            <h3 className="text-xl font-semibold">{t('application.success.title')}</h3>
            {(cycle.settings as any)?.success_message && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-left">
                <p className="text-sm text-muted-foreground whitespace-pre-line">
                  {(cycle.settings as any).success_message}
                </p>
              </div>
            )}

            <p className="text-muted-foreground">
              {isGuest 
                ? t('application.success.guestMessage', 'Your application has been submitted! Please check your email to verify your account.')
                : t('application.success.message')}
            </p>
            
            <div className="text-left mt-6 p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">{t('application.success.whatNext')}</h4>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                <li>{t('application.success.step1')}</li>
                <li>{t('application.success.step2')}</li>
                <li>{t('application.success.step3')}</li>
              </ol>
            </div>

            {onCancel && (
              <Button variant="outline" onClick={onCancel} className="mt-4">
                {t('application.success.backToProfile')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const rawStandardAllowed = (cycle.settings.lesson_types as string[] | undefined) || [...STANDARD_LESSON_TYPES];
  // Migrate legacy 'group' → 'group3' + 'group4'
  const standardAllowed = [...new Set(rawStandardAllowed.flatMap(t => t === 'group' ? ['group3', 'group4'] : [t]))];
  const customTypes = (cycle.settings.custom_lesson_types as string[] | undefined) || [];
  const allowedLessonTypes = [...standardAllowed, ...customTypes];
  const showTrainerPreference = cycle.settings.show_preferred_trainer && trainers.length > 0;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit, (errors) => {
          // Auto-scroll to first error field
          setTimeout(() => {
            const firstErrorKey = Object.keys(errors)[0];
            if (firstErrorKey) {
              const el = document.querySelector(`[name="${firstErrorKey}"]`)
                || document.getElementById(`${firstErrorKey}-form-item`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }, 100);
        })} className="space-y-6">
        {isWaitlist && (
          <div className="rounded-lg border border-border bg-muted/50 p-4 flex gap-3">
            <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium">{t('application.deadlinePassed')}</p>
              <p className="text-muted-foreground mt-1">
                {t('application.deadlinePassedWaitlist', "The deadline has passed — you'll be added to the waiting list.")}
              </p>
            </div>
          </div>
        )}
        {/* Personal Information */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.personalInfo')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="first_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.firstName')}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="given-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="last_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.lastName')}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="family-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.email')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" disabled={!isGuest} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.phone')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="tel" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="birth_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.birthDate')}</FormLabel>
                  <FormControl>
                    <DateInputField {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />


            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="rating"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.rating')}</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" step="0.1" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormItem>
                <FormLabel>{t('application.form.ratingSystem')}</FormLabel>
                <p className="text-sm text-muted-foreground py-2 px-3 bg-muted rounded-md">
                  {ratingSystems.find(rs => rs.code === form.getValues('rating_system'))?.name || form.getValues('rating_system')?.toUpperCase() || 'KNLTB'}
                </p>
              </FormItem>
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.notes')}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder={t('application.form.notesPlaceholder')}
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Payment method choice — shown for any cycle set to "player chooses" (both) */}
        {eventPaymentMethods === 'both' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('application.form.paymentMethod', 'Payment Method')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('application.form.choosePayment', 'How would you like to pay?')}</p>
              <label className={cn(
                "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                selectedPaymentMethod === 'online' && "border-primary bg-primary/5"
              )}>
                <input
                  type="radio"
                  name="player_payment"
                  value="online"
                  checked={selectedPaymentMethod === 'online'}
                  onChange={() => setSelectedPaymentMethod('online')}
                  className="mt-1"
                />
                <div className="space-y-0.5">
                  <span className="text-sm font-medium flex items-center gap-1">
                    <CreditCard className="h-4 w-4" />
                    {t('application.form.payOnline', 'Pay Online')}
                  </span>
                  <p className="text-xs text-muted-foreground">{t('application.form.payOnlineDesc', 'Pay securely via the platform')}</p>
                </div>
              </label>
              <label className={cn(
                "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                selectedPaymentMethod === 'cash' && "border-primary bg-primary/5"
              )}>
                <input
                  type="radio"
                  name="player_payment"
                  value="cash"
                  checked={selectedPaymentMethod === 'cash'}
                  onChange={() => setSelectedPaymentMethod('cash')}
                  className="mt-1"
                />
                <div className="space-y-0.5">
                  <span className="text-sm font-medium flex items-center gap-1">
                    <Banknote className="h-4 w-4" />
                    {t('application.form.payAtLocation', 'Pay at Location')}
                  </span>
                  <p className="text-xs text-muted-foreground">{t('application.form.payAtLocationDesc', 'Pay cash or pin on arrival')}</p>
                </div>
              </label>
            </CardContent>
          </Card>
        )}

        {/* Event price display */}
        {isEvent && cycle.total_price && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t('application.form.eventPrice', 'Price')}</span>
                <span className="text-lg font-semibold">
                  {formatCurrency(cycle.total_price)}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Cyclus Option Selector */}
        {hasCyclusOptions && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('application.form.chooseCyclus', 'Choose your cyclus')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {cyclusOptions.map((opt, i) => {
                const isSelected = selectedCyclusOption?.label === opt.label && selectedCyclusOption?.number_of_sessions === opt.number_of_sessions;
                return (
                  <label
                    key={i}
                    className={cn(
                      "flex items-center justify-between rounded-lg border p-4 cursor-pointer transition-colors",
                      isSelected && "border-primary bg-primary/5"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="radio"
                        name="cyclus_option"
                        checked={isSelected}
                        onChange={() => setSelectedCyclusOption(opt)}
                        className="mt-0.5"
                      />
                      <div>
                        <span className="text-sm font-medium">{opt.label}</span>
                        <p className="text-xs text-muted-foreground">
                          {opt.number_of_sessions} {t('application.form.lessons', 'lessen')}
                          {opt.number_of_weeks ? ` · ${opt.number_of_weeks} ${t('application.form.weeks', 'weken')}` : ''}
                          {' · '}{formatCurrency(opt.price_per_session)} {t('application.form.perLesson', 'per les')}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-semibold">
                      {formatCurrency(opt.total_price)}
                    </span>
                  </label>
                );
              })}
            </CardContent>
          </Card>
        )}


        {/* Preferences - hide for events */}
        {!isEvent && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.preferences')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="lesson_types"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.lessonType')}</FormLabel>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {allowedLessonTypes.map(type => {
                      const isChecked = field.value?.includes(type) ?? false;
                      const toggle = () => {
                        const current = field.value || [];
                        const updated = current.includes(type)
                          ? current.filter((v: string) => v !== type)
                          : [...current, type];
                        field.onChange(updated);
                      };
                      return (
                        <label
                          key={type}
                          className="flex items-center space-x-2 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
                        >
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={toggle}
                          />
                          <span className="font-normal cursor-pointer flex-1 m-0 text-sm">
                            {(STANDARD_LESSON_TYPES as readonly string[]).includes(type)
                              ? t(`application.form.lessonTypes.${type}`)
                              : type.charAt(0).toUpperCase() + type.slice(1)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="preferred_duration_minutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.preferredDuration')}</FormLabel>
                  {effectiveDurations.length === 1 ? (
                    <Input value={`${effectiveDurations[0]} min`} disabled className="bg-muted" />
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                      {effectiveDurations.map(d => {
                        const isSelected = field.value === d;
                        return (
                          <label
                            key={d}
                            className={cn(
                              "flex items-center space-x-2 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors",
                              isSelected && "border-primary bg-primary/5"
                            )}
                          >
                            <input
                              type="radio"
                              name="preferred_duration_minutes"
                              checked={isSelected}
                              onChange={() => field.onChange(Number(d))}
                            />
                            <span className="font-normal cursor-pointer flex-1 m-0 text-sm">
                              {d} min
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            {hasDurationOptions && (
              <div>
                <Label className="text-sm font-medium">{t('application.form.preferredWeeks')}</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                  {durationOptions.sort((a, b) => a - b).map((weeks) => {
                    const isSelected = selectedDurationWeeks === weeks;
                    return (
                      <label
                        key={weeks}
                        className={cn(
                          "flex items-center space-x-2 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors",
                          isSelected && "border-primary bg-primary/5"
                        )}
                      >
                        <input
                          type="radio"
                          name="duration_option"
                          checked={isSelected}
                          onChange={() => setSelectedDurationWeeks(weeks)}
                        />
                        <span className="font-normal cursor-pointer flex-1 m-0 text-sm">
                          {weeks} {t('application.form.weeks', 'weken')}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <FormField
              control={form.control}
              name="group_notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.groupNotes')}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder={t('application.form.groupNotesPlaceholder')}
                      className="min-h-[80px]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {showTrainerPreference && (
              <FormField
                control={form.control}
                name="preferred_trainer_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.preferredTrainer')}</FormLabel>
                    <Select onValueChange={(val) => field.onChange(val === '__none__' ? '' : val)} value={field.value || '__none__'}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('application.form.noPreference')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">{t('application.form.noPreference')}</SelectItem>
                        {trainers.map(trainer => (
                          <SelectItem key={trainer.id} value={trainer.id}>
                            {trainer.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {!cycle.location_id && locations.length > 1 && (
              <FormField
                control={form.control}
                name="location_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.location')}</FormLabel>
                    <Select onValueChange={(val) => field.onChange(val === '__none__' ? '' : val)} value={field.value || '__none__'}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('application.form.noPreference')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">{t('application.form.noPreference')}</SelectItem>
                        {locations.map(loc => (
                          <SelectItem key={loc.id} value={loc.id}>
                            {loc.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </CardContent>
        </Card>
        )}

        {/* Availability - hide for events */}
        {!isEvent && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.availability')}</CardTitle>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="availability"
              render={({ field }) => (
                <FormItem>
                  <FormDescription className="mb-4">
                    {t('application.form.availabilityHelp')}
                  </FormDescription>
                  <FormControl>
                    <DayAvailabilityPicker
                      value={field.value as DayAvailability}
                      onChange={field.onChange}
                      allowedDays={cyclAvailableDays}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
        )}

        {/* Selection Summary Calculator */}
        {!isEvent && (cycle.settings as any)?.show_price_indication !== false && (() => {
          const watchedLessonTypes = form.watch('lesson_types') || [];
          const watchedDuration = form.watch('preferred_duration_minutes');
          
          if (watchedLessonTypes.length === 0) return null;

          // Number of lessons to price: a chosen cyclus option carries the academy's
          // real (holiday-adjusted) lesson count; else a chosen duration; else the
          // cycle's whole-week span — FLOORED so it matches the editor's number-of-weeks
          // (a Mon->Fri end reads as 10, not the rounded-up 11).
          // CANONICAL: this must stay in step with the server's resolveRegistrationLessonCount
          // (supabase/functions/_shared/registration-pricing.ts) — the authority that prices the
          // invoice + confirmation email. Both floor the date span; keep them aligned. (A single
          // shared import is the eventual dedup — see audit/PRICING_DEDUP.md.)
          const lessonCount = selectedCyclusOption?.number_of_sessions
            || selectedDurationWeeks
            || (cycle.start_date && cycle.end_date
              ? Math.max(1, Math.floor((new Date(cycle.end_date).getTime() - new Date(cycle.start_date).getTime()) / (7 * 24 * 60 * 60 * 1000)))
              : null);
          const isLessonUnit = !!selectedCyclusOption;

          // Build price lines per selected lesson type
          const rawStdTypes = (cycle.settings?.lesson_types as string[] | undefined) || [...STANDARD_LESSON_TYPES];
          const standardAllowedTypes = [...new Set(rawStdTypes.flatMap(t => t === 'group' ? ['group3', 'group4'] : [t]))];
          const customTypes = (cycle.settings?.custom_lesson_types as string[] | undefined) || [];
          const orderedTypes = [...standardAllowedTypes, ...customTypes];

          const priceLines: { label: string; perLesson: number | null; total: number | null }[] = [];

          for (const lt of watchedLessonTypes) {
            const displayLabel = (STANDARD_LESSON_TYPES as readonly string[]).includes(lt)
              ? t(`application.form.lessonTypes.${lt}`)
              : lt.charAt(0).toUpperCase() + lt.slice(1);

            let perLesson: number | null = null;

            if (selectedCyclusOption) {
              perLesson = selectedCyclusOption.price_per_session;
            } else if (cycle.price_table && cycle.price_table.length > 0) {
              const typeIndex = orderedTypes.indexOf(lt);
              const priceRow = typeIndex >= 0 && typeIndex < cycle.price_table.length
                ? cycle.price_table[typeIndex]
                : null;
              if (priceRow) perLesson = priceRow.price;
            }

            if (perLesson == null && cycle.price_per_session) {
              perLesson = cycle.price_per_session;
            }

            // For a cyclus option the academy-set total is authoritative (it's what the
            // server invoices); otherwise price = per-lesson x lesson count.
            const total = selectedCyclusOption
              ? (selectedCyclusOption.total_price ?? (perLesson && lessonCount ? perLesson * lessonCount : null))
              : (perLesson && lessonCount ? perLesson * lessonCount : null);
            priceLines.push({ label: displayLabel, perLesson, total });
          }

          return (
            <Card className="border-muted bg-muted/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Info className="h-4 w-4 text-muted-foreground" />
                  {t('application.summary.priceIndication')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {cyclusOptions.length > 0 ? (
                  // Package cycles (e.g. Leden / Niet-leden): show EVERY option with its
                  // lesson count + total — the price the server actually invoices — so the
                  // registrant sees all options side by side, not just a per-lesson rate.
                  cyclusOptions.map((opt, i) => (
                    <div key={i} className="flex items-center justify-between gap-4">
                      <span className="text-muted-foreground">{opt.label}</span>
                      <span className="font-medium text-right whitespace-nowrap">
                        {opt.number_of_sessions} {t('application.form.lessons', 'lessen')}
                        {opt.price_per_session != null ? ` · ${formatCurrency(opt.price_per_session)}/${t('form.perLesson')}` : ''}
                        {opt.total_price != null ? ` · ${formatCurrency(opt.total_price)}` : ''}
                      </span>
                    </div>
                  ))
                ) : (
                  priceLines.map((line, i) => (
                    <div key={i} className="flex items-center justify-between gap-4">
                      <span className="text-muted-foreground">{line.label}</span>
                      <span className="font-medium text-right whitespace-nowrap">
                        {line.perLesson != null && line.perLesson > 0 ? (
                          <>
                            {formatCurrency(line.perLesson)}/{t('form.perLesson')}
                            {line.total != null && lessonCount && (
                              <span className="text-muted-foreground font-normal ml-2">
                                {lessonCount} {isLessonUnit ? t('application.form.lessons', 'lessen') : t('application.form.weeks', 'weken')}: {formatCurrency(line.total)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </span>
                    </div>
                  ))
                )}

                {selectedCyclusOption && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('application.summary.package')}</span>
                    <span className="font-medium">{selectedCyclusOption.label}</span>
                  </div>
                )}

                {watchedDuration && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t('application.summary.lessonLength')}</span>
                    <span className="font-medium">{watchedDuration} min</span>
                  </div>
                )}

              </CardContent>
            </Card>
          );
        })()}

        <FormField
          control={form.control}
          name="consent"
          render={({ field }) => (
            <FormItem className="flex flex-row items-start space-x-3 space-y-0">
              <FormControl>
                <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <div className="space-y-1 leading-none">
                <FormLabel className="font-normal">
                  {t('application.form.consent')}
                </FormLabel>
                <FormMessage />
              </div>
            </FormItem>
          )}
        />


        <TermsAcceptance
          terms={cycleTerms}
          loading={termsLoading}
          accepted={termsAccepted}
          onAcceptChange={setTermsAccepted}
        />

        {/* Validation error summary near submit button */}
        {Object.keys(form.formState.errors).length > 0 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive space-y-1">
            <p className="font-medium">{t('application.form.validationSummary', 'Please fix the following:')}</p>
            <ul className="list-disc pl-4 space-y-0.5">
              {form.formState.errors.first_name && <li>{t('application.form.firstName')}</li>}
              {form.formState.errors.last_name && <li>{t('application.form.lastName')}</li>}
              {form.formState.errors.email && <li>{t('application.form.email')}</li>}
              {form.formState.errors.birth_date && <li>{t('application.form.birthDate')}</li>}
              {form.formState.errors.notes && <li>{t('application.form.notes')}</li>}
              {form.formState.errors.lesson_types && <li>{t('application.form.lessonType')}</li>}
              {form.formState.errors.availability && <li>{t('application.form.availabilityLabel')}</li>}
              {form.formState.errors.consent && <li>{t('application.form.consent')}</li>}
              {form.formState.errors.rating && <li>{t('application.form.rating')}</li>}
              {form.formState.errors.phone && <li>{t('application.form.phone')}</li>}
              {form.formState.errors.password && <li>{t('application.form.password')}</li>}
            </ul>
          </div>
        )}

        {/* Submit */}
        <div className="flex gap-3">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
              {t('common:cancel', 'Cancel')}
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting || (!!cycleTerms && !termsAccepted)} className="flex-1">
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('application.form.submitting')}
              </>
            ) : (
              isWaitlist ? t('application.applyWaitlist', 'Join waiting list') : t('application.form.submit')
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
