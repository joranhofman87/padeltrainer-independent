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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateIntakeRequest, type IntakeRequestWithProposal, type TimeWindow } from '@/lib/cycles';
import DayAvailabilityPicker, { type DayAvailability } from './DayAvailabilityPicker';

interface EditIntakeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: IntakeRequestWithProposal;
  onSuccess: () => void;
}

const formSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  phone: z.string().optional(),
  rating: z.coerce.number().min(0).max(12).optional().or(z.literal('')),
  rating_system: z.string(),
  preferred_duration_minutes: z.coerce.number().min(30).max(180),
  sessions_per_week: z.coerce.number().min(1).max(7),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

const LESSON_TYPES = ['private', 'duo', 'group3', 'group4', 'kids'] as const;

export default function EditIntakeRequestDialog({
  open,
  onOpenChange,
  request,
  onSuccess,
}: EditIntakeRequestDialogProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedLessonTypes, setSelectedLessonTypes] = useState<string[]>([]);
  const [dayAvailability, setDayAvailability] = useState<DayAvailability>({});

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      full_name: '',
      email: '',
      phone: '',
      rating: '' as any,
      rating_system: 'knltb',
      preferred_duration_minutes: 60,
      sessions_per_week: 1,
      notes: '',
    },
  });

  useEffect(() => {
    if (open && request) {
      form.reset({
        full_name: request.full_name,
        email: request.email,
        phone: request.phone || '',
        rating: request.rating ?? ('' as any),
        rating_system: request.rating_system || 'knltb',
        preferred_duration_minutes: request.preferred_duration_minutes || 60,
        sessions_per_week: request.sessions_per_week || 1,
        notes: request.notes || '',
      });

      const lessonTypes = Array.isArray(request.lesson_type) ? request.lesson_type : [request.lesson_type];
      setSelectedLessonTypes(lessonTypes);

      // Convert TimeWindow[] to DayAvailability record
      const avail: DayAvailability = {};
      const windows = request.preferred_time_windows || [];
      for (const tw of windows) {
        if (!avail[tw.day]) avail[tw.day] = [];
        avail[tw.day].push({ start: tw.start, end: tw.end });
      }
      // Also add enabled days with no windows as default windows
      for (const day of (request.preferred_days || [])) {
        if (!avail[day]) avail[day] = [{ start: '09:00', end: '17:00' }];
      }
      setDayAvailability(avail);
    }
  }, [open, request]);

  const handleSubmit = async (values: FormValues) => {
    setIsSubmitting(true);
    try {
      const preferredDays = Object.keys(dayAvailability).filter(day => dayAvailability[day].length > 0);
      const timeWindows: TimeWindow[] = Object.entries(dayAvailability)
        .flatMap(([day, blocks]) => blocks.map(b => ({ day, start: b.start, end: b.end })));

      await updateIntakeRequest(request.id, {
        full_name: values.full_name,
        email: values.email,
        phone: values.phone || null,
        rating: values.rating !== '' && values.rating !== undefined ? Number(values.rating) : null,
        rating_system: values.rating_system,
        lesson_type: selectedLessonTypes,
        preferred_days: preferredDays,
        preferred_time_windows: timeWindows,
        preferred_duration_minutes: values.preferred_duration_minutes,
        sessions_per_week: values.sessions_per_week,
        notes: values.notes || null,
      });

      toast.success(t('intakeRequests.edit.success', { defaultValue: 'Registratie bijgewerkt' }));
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleLessonType = (type: string) => {
    setSelectedLessonTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('intakeRequests.edit.title', { defaultValue: 'Registratie bewerken' })}</DialogTitle>
          <DialogDescription>
            {t('intakeRequests.edit.description', { defaultValue: 'Pas de registratiegegevens aan' })}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {/* Name & Email */}
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="full_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.name', { defaultValue: 'Naam' })}</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.email', { defaultValue: 'E-mail' })}</FormLabel>
                    <FormControl><Input type="email" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Phone & Rating */}
            <div className="grid grid-cols-3 gap-3">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.phone', { defaultValue: 'Telefoon' })}</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rating"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.rating', { defaultValue: 'Rating' })}</FormLabel>
                    <FormControl><Input type="number" step="0.01" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rating_system"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.ratingSystem', { defaultValue: 'Systeem' })}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="knltb">KNLTB</SelectItem>
                        <SelectItem value="utr">UTR</SelectItem>
                        <SelectItem value="ntrp">NTRP</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Lesson Types */}
            <div>
              <Label className="text-sm font-medium">{t('application.form.lessonType', { defaultValue: 'Lesvorm' })}</Label>
              <div className="flex flex-wrap gap-2 mt-2">
                {LESSON_TYPES.map(type => (
                  <Button
                    key={type}
                    type="button"
                    variant={selectedLessonTypes.includes(type) ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleLessonType(type)}
                  >
                    {t(`application.form.lessonTypes.${type}`, { defaultValue: type })}
                  </Button>
                ))}
              </div>
            </div>

            {/* Duration & Sessions */}
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="preferred_duration_minutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.duration', { defaultValue: 'Duur (min)' })}</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sessions_per_week"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('application.form.sessionsPerWeek', { defaultValue: 'Sessies/week' })}</FormLabel>
                    <FormControl><Input type="number" min={1} max={7} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Availability */}
            <div>
              <Label className="text-sm font-medium">{t('intakeRequests.detail.availability', { defaultValue: 'Beschikbaarheid' })}</Label>
              <div className="mt-2">
                <DayAvailabilityPicker
                  value={dayAvailability}
                  onChange={setDayAvailability}
                />
              </div>
            </div>

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('intakeRequests.detail.notes', { defaultValue: 'Opmerkingen' })}</FormLabel>
                  <FormControl><Textarea rows={3} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:cancel', { defaultValue: 'Annuleren' })}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('intakeRequests.edit.saving', { defaultValue: 'Opslaan...' })
                  : t('intakeRequests.edit.save', { defaultValue: 'Wijzigingen opslaan' })}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
