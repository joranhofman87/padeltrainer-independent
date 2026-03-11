import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, CheckCircle2, CreditCard, Banknote } from 'lucide-react';
import { getTermsForCycleOwner } from '@/lib/terms';
import { logger } from '@/lib/logger';
import TermsAcceptance from '@/components/booking/TermsAcceptance';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { submitIntakeRequest, type Cycle, type TimeWindow, type EventPaymentMethod } from '@/lib/cycles';
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
  playerEmail: string;
  playerPhone?: string;
  playerRating?: number;
  playerRatingSystem?: string;
  playerBirthDate?: string;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
  isGuest?: boolean;
  onSuccess?: () => void;
  onCancel?: () => void;
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const STANDARD_LESSON_TYPES = ['private', 'duo', 'group', 'kids'] as const;
const DURATIONS = [30, 45, 60, 90, 120] as const;

export default function CycleApplicationForm({
  cycle,
  playerId,
  playerUserId,
  playerName,
  playerEmail,
  playerPhone,
  playerRating,
  playerRatingSystem = 'knltb',
  playerBirthDate,
  trainers = [],
  locations = [],
  isGuest = false,
  onSuccess,
  onCancel,
}: CycleApplicationFormProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [ratingSystems, setRatingSystems] = useState<{ code: string; name: string }[]>([]);
  const [cycleTerms, setCycleTerms] = useState<string | null>(null);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'online' | 'cash'>('online');
  
  const isEvent = cycle.type === 'event';
  const eventPaymentMethods = (cycle.settings as any)?.payment_methods as EventPaymentMethod | undefined;
  
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

  const formSchema = z.object({
    full_name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().optional(),
    birth_date: z.string().min(1, t('application.form.birthDateRequired')),
    rating: z.coerce.number().optional(),
    rating_system: z.string(),
    lesson_types: isEvent ? z.array(z.string()).optional().default([]) : z.array(z.string()).min(1, t('application.form.lessonTypeRequired')),
    preferred_duration_minutes: z.coerce.number(),
    sessions_per_week: z.coerce.number().min(1).max(7).default(1),
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
      full_name: playerName || '',
      email: playerEmail || '',
      phone: playerPhone || '',
      birth_date: playerBirthDate || '',
      
      rating: playerRating || undefined,
      rating_system: playerRatingSystem,
      lesson_types: ['group'] as string[],
      preferred_duration_minutes: cycle.settings.default_duration_minutes || 60,
      sessions_per_week: 1,
      availability: {},
      preferred_trainer_id: '',
      location_id: '',
      notes: '',
      group_notes: '',
      consent: false,
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
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

      if (isGuest) {
        // Guest flow: edge function handles account creation + intake
        const { data: result, error: fnError } = await supabase.functions.invoke('submit-guest-intake', {
          body: {
            email: values.email,
            fullName: values.full_name,
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
            notes: [values.notes, values.group_notes].filter(Boolean).join('\n\n') || undefined,
            consentGiven: values.consent,
          },
        });

        if (fnError) throw fnError;
        if (result?.error) throw new Error(result.error);
      } else {
        // Logged-in user flow
        await submitIntakeRequest({
          cycle_id: cycle.id,
          player_id: playerId,
          full_name: values.full_name,
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
          notes: [values.notes, values.group_notes].filter(Boolean).join('\n\n') || undefined,
          consent_given: values.consent,
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
        if (Object.keys(profileUpdates).length > 0) {
          await supabase
            .from('profiles')
            .update(profileUpdates)
            .eq('user_id', playerUserId);
        }
      }

      setIsSuccess(true);
      toast.success(t('application.success.title'));
      onSuccess?.();
    } catch (error: any) {
      console.error('Error submitting application:', error);
      toast.error(error.message || 'Failed to submit application');
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
            {(cycle.settings as any)?.success_message ? (
              <p className="text-muted-foreground whitespace-pre-line">
                {(cycle.settings as any).success_message}
              </p>
            ) : (
              <>
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
              </>
            )}

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

  const standardAllowed = (cycle.settings.lesson_types as string[] | undefined) || [...STANDARD_LESSON_TYPES];
  const customTypes = (cycle.settings.custom_lesson_types as string[] | undefined) || [];
  const allowedLessonTypes = [...standardAllowed, ...customTypes];
  const showTrainerPreference = cycle.settings.show_preferred_trainer && trainers.length > 0;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Personal Information */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.personalInfo')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="full_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.name')}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.email')}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" disabled={!isGuest} />
                  </FormControl>
                  {isGuest && (
                    <FormDescription className="text-xs">
                      {t('application.form.yourEmailHelp', 'We\'ll send you a confirmation and a link to set up your account.')}
                    </FormDescription>
                  )}
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

              <FormField
                control={form.control}
                name="rating_system"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.ratingSystem')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ratingSystems.map(rs => (
                          <SelectItem key={rs.code} value={rs.code}>
                            {rs.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
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

        {/* Event Payment Method Selection */}
        {isEvent && eventPaymentMethods === 'both' && (
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
                  {new Intl.NumberFormat('nl-NL', { style: 'currency', currency: cycle.currency || 'EUR' }).format(cycle.total_price)}
                </span>
              </div>
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
                  <Select onValueChange={field.onChange} value={String(field.value)}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DURATIONS.map(d => (
                        <SelectItem key={d} value={String(d)}>
                          {d} min
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="sessions_per_week"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.sessionsPerWeek')}</FormLabel>
                  <Select onValueChange={field.onChange} value={String(field.value)}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {[1, 2, 3, 4, 5, 6, 7].map(n => (
                        <SelectItem key={n} value={String(n)}>
                          {n}× {t('application.form.timesPerWeek')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
        )}

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
              t('application.form.submit')
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
