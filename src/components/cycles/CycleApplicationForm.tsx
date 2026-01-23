import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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
import { supabase } from '@/integrations/supabase/client';
import { submitIntakeRequest, type Cycle, type TimeWindow } from '@/lib/cycles';
import { toast } from 'sonner';

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
  playerName: string;
  playerEmail: string;
  playerRating?: number;
  playerRatingSystem?: string;
  trainers?: TrainerOption[];
  locations?: LocationOption[];
  onSuccess?: () => void;
  onCancel?: () => void;
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const TIME_PRESETS = ['morning', 'afternoon', 'evening', 'weekend'] as const;
const LESSON_TYPES = ['private', 'duo', 'group', 'kids'] as const;
const DURATIONS = [30, 45, 60, 90, 120] as const;

export default function CycleApplicationForm({
  cycle,
  playerId,
  playerName,
  playerEmail,
  playerRating,
  playerRatingSystem = 'knltb',
  trainers = [],
  locations = [],
  onSuccess,
  onCancel,
}: CycleApplicationFormProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [ratingSystems, setRatingSystems] = useState<{ code: string; name: string }[]>([]);
  
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

  const formSchema = z.object({
    full_name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    rating: z.coerce.number().optional(),
    rating_system: z.string(),
    lesson_type: z.enum(LESSON_TYPES),
    preferred_duration_minutes: z.coerce.number(),
    preferred_days: z.array(z.string()).min(1, t('application.form.preferredDays') + ' is required'),
    time_presets: z.array(z.string()).min(1),
    preferred_trainer_id: z.string().optional(),
    location_id: z.string().optional(),
    notes: z.string().optional(),
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
      phone: '',
      rating: playerRating || undefined,
      rating_system: playerRatingSystem,
      lesson_type: (cycle.settings.lesson_types?.[0] as typeof LESSON_TYPES[number]) || 'private',
      preferred_duration_minutes: cycle.settings.default_duration_minutes || 60,
      preferred_days: [],
      time_presets: [],
      preferred_trainer_id: '',
      location_id: '',
      notes: '',
      consent: false,
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    try {
      // Convert time presets to time windows
      const timeWindows: TimeWindow[] = values.time_presets.map(preset => ({
        preset: preset as TimeWindow['preset'],
      }));

      await submitIntakeRequest({
        cycle_id: cycle.id,
        player_id: playerId,
        full_name: values.full_name,
        email: values.email,
        phone: values.phone,
        rating: values.rating,
        rating_system: values.rating_system,
        lesson_type: values.lesson_type,
        preferred_days: values.preferred_days,
        preferred_time_windows: timeWindows,
        preferred_duration_minutes: values.preferred_duration_minutes,
        preferred_trainer_id: values.preferred_trainer_id || undefined,
        location_id: values.location_id || undefined,
        notes: values.notes,
        consent_given: values.consent,
      });

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
            <p className="text-muted-foreground">{t('application.success.message')}</p>
            
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

  const allowedLessonTypes = cycle.settings.lesson_types || LESSON_TYPES;
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
                    <Input {...field} type="email" disabled />
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

            <div className="grid grid-cols-2 gap-4">
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
          </CardContent>
        </Card>

        {/* Preferences */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.preferences')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="lesson_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.lessonType')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {allowedLessonTypes.map(type => (
                        <SelectItem key={type} value={type}>
                          {t(`application.form.lessonTypes.${type}`)}
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

            {showTrainerPreference && (
              <FormField
                control={form.control}
                name="preferred_trainer_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.preferredTrainer')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ''}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('application.form.noPreference')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">{t('application.form.noPreference')}</SelectItem>
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

            {locations.length > 1 && (
              <FormField
                control={form.control}
                name="location_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.location')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ''}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('application.form.noPreference')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">{t('application.form.noPreference')}</SelectItem>
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

        {/* Availability */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.availability')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="preferred_days"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.preferredDays')}</FormLabel>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {DAYS.map(day => (
                      <div key={day} className="flex items-center space-x-2">
                        <Checkbox
                          id={`day-${day}`}
                          checked={field.value.includes(day)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              field.onChange([...field.value, day]);
                            } else {
                              field.onChange(field.value.filter(d => d !== day));
                            }
                          }}
                        />
                        <Label htmlFor={`day-${day}`} className="text-sm font-normal">
                          {t(`application.form.days.${day}`)}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="time_presets"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.timeWindows')}</FormLabel>
                  <div className="grid grid-cols-2 gap-2">
                    {TIME_PRESETS.map(preset => (
                      <div key={preset} className="flex items-center space-x-2">
                        <Checkbox
                          id={`time-${preset}`}
                          checked={field.value.includes(preset)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              field.onChange([...field.value, preset]);
                            } else {
                              field.onChange(field.value.filter(p => p !== preset));
                            }
                          }}
                        />
                        <Label htmlFor={`time-${preset}`} className="text-sm font-normal">
                          {t(`application.form.timePresets.${preset}`)}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Additional Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('application.form.additional')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex gap-3">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
              {t('common:cancel', 'Cancel')}
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting} className="flex-1">
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
