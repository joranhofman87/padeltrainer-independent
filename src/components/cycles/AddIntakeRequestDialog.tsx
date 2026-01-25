import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { createManualIntakeRequest, type Cycle, type TimeWindow } from '@/lib/cycles';
import DayAvailabilityPicker, { type DayAvailability } from './DayAvailabilityPicker';

interface AddIntakeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cycleId?: string;
  cycles: Cycle[];
  onSuccess: () => void;
}

const formSchema = z.object({
  cycle_id: z.string().min(1, 'Please select a cycle'),
  full_name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().email('Invalid email').max(255),
  phone: z.string().optional(),
  rating_system: z.string().default('knltb'),
  rating: z.coerce.number().optional(),
  lesson_type: z.enum(['private', 'duo', 'group', 'kids']),
  preferred_duration_minutes: z.coerce.number().default(60),
  notes: z.string().optional(),
});

type FormData = z.infer<typeof formSchema>;

// Convert DayAvailability to TimeWindow array
function dayAvailabilityToTimeWindows(dayAvailability: DayAvailability): TimeWindow[] {
  const windows: TimeWindow[] = [];
  for (const [day, blocks] of Object.entries(dayAvailability)) {
    for (const block of blocks) {
      windows.push({ day, start: block.start, end: block.end });
    }
  }
  return windows;
}

export default function AddIntakeRequestDialog({
  open,
  onOpenChange,
  cycleId,
  cycles,
  onSuccess,
}: AddIntakeRequestDialogProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ratingSystems, setRatingSystems] = useState<Array<{
    code: string;
    name: string;
    min_rating: number;
    max_rating: number;
    step: number;
  }>>([]);
  const [dayAvailability, setDayAvailability] = useState<DayAvailability>({});

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      cycle_id: cycleId || '',
      full_name: '',
      email: '',
      phone: '',
      rating_system: 'knltb',
      rating: undefined,
      lesson_type: 'private',
      preferred_duration_minutes: 60,
      notes: '',
    },
  });

  useEffect(() => {
    if (cycleId) {
      form.setValue('cycle_id', cycleId);
    }
  }, [cycleId, form]);

  useEffect(() => {
    const fetchRatingSystems = async () => {
      const { data } = await supabase
        .from('rating_systems')
        .select('code, name, min_rating, max_rating, step')
        .eq('is_active', true)
        .order('display_order');
      if (data) setRatingSystems(data);
    };
    fetchRatingSystems();
  }, []);

  const selectedRatingSystem = ratingSystems.find(
    (rs) => rs.code === form.watch('rating_system')
  );

  const handleSubmit = async (data: FormData) => {
    const timeWindows = dayAvailabilityToTimeWindows(dayAvailability);
    
    if (timeWindows.length === 0) {
      toast.error(t('application.form.noAvailability'));
      return;
    }

    setIsSubmitting(true);
    try {
      // Step 1: Create or find the player account
      const { data: playerData, error: playerError } = await supabase.functions.invoke(
        'create-manual-player',
        {
          body: {
            email: data.email,
            fullName: data.full_name,
            phone: data.phone,
            ratingSystem: data.rating_system,
            rating: data.rating,
          },
        }
      );

      if (playerError) {
        throw new Error(playerError.message || 'Failed to create player account');
      }

      if (playerData?.error) {
        throw new Error(playerData.error);
      }

      // Step 2: Create the intake request with the real player_id
      const preferredDays = [...new Set(timeWindows.map((tw) => tw.day!))];

      await createManualIntakeRequest({
        cycle_id: data.cycle_id,
        player_id: playerData.profileId,
        full_name: data.full_name,
        email: data.email,
        phone: data.phone || undefined,
        rating_system: data.rating_system,
        rating: data.rating,
        lesson_type: data.lesson_type,
        preferred_days: preferredDays,
        preferred_time_windows: timeWindows,
        preferred_duration_minutes: data.preferred_duration_minutes,
        notes: data.notes || undefined,
        consent_given: true,
      });

      // Show success message
      if (playerData.isNewUser) {
        toast.success(t('intakeRequests.addManualSuccessNewAccount'));
      } else {
        toast.success(t('intakeRequests.addManualSuccess'));
      }
      
      form.reset();
      setDayAvailability({});
      onSuccess();
    } catch (error: any) {
      console.error('Error creating intake request:', error);
      toast.error(error.message || 'Failed to add registration');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('intakeRequests.addManualTitle')}</DialogTitle>
          <DialogDescription>
            {t('intakeRequests.addManualDescription')}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
            {/* Cycle Selection (if not pre-selected) */}
            {!cycleId && (
              <FormField
                control={form.control}
                name="cycle_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('cycle')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('form.name')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {cycles.map((cycle) => (
                          <SelectItem key={cycle.id} value={cycle.id}>
                            {cycle.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Personal Info */}
            <div className="space-y-4">
              <h3 className="font-medium">{t('application.form.personalInfo')}</h3>
              
              <div className="grid gap-4 sm:grid-cols-2">
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
                        <Input type="email" {...field} />
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
                        <Input type="tel" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Rating */}
            <div className="grid gap-4 sm:grid-cols-2">
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
                        {ratingSystems.map((rs) => (
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

              <FormField
                control={form.control}
                name="rating"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.rating')}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step={selectedRatingSystem?.step || 0.1}
                        min={selectedRatingSystem?.min_rating}
                        max={selectedRatingSystem?.max_rating}
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Training Preferences */}
            <div className="space-y-4">
              <h3 className="font-medium">{t('application.form.preferences')}</h3>
              
              <div className="grid gap-4 sm:grid-cols-2">
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
                          <SelectItem value="private">
                            {t('application.form.lessonTypes.private')}
                          </SelectItem>
                          <SelectItem value="duo">
                            {t('application.form.lessonTypes.duo')}
                          </SelectItem>
                          <SelectItem value="group">
                            {t('application.form.lessonTypes.group')}
                          </SelectItem>
                          <SelectItem value="kids">
                            {t('application.form.lessonTypes.kids')}
                          </SelectItem>
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
                      <Select
                        onValueChange={(v) => field.onChange(parseInt(v))}
                        value={String(field.value)}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="30">30 min</SelectItem>
                          <SelectItem value="45">45 min</SelectItem>
                          <SelectItem value="60">60 min</SelectItem>
                          <SelectItem value="90">90 min</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Availability */}
            <div className="space-y-4">
              <h3 className="font-medium">{t('application.form.availability')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('application.form.availabilityHelp')}
              </p>
              <DayAvailabilityPicker
                value={dayAvailability}
                onChange={setDayAvailability}
              />
            </div>

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.notes')}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t('application.form.notesPlaceholder')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Submit */}
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('proposals.confirmDialog.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t('application.form.submitting') : t('intakeRequests.addManual')}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
