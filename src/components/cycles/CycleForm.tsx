import React, { useState, useEffect } from 'react';
import { getRatingSystems, type RatingSystemConfig } from '@/lib/ratingSystems';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format, differenceInWeeks, addWeeks, differenceInMinutes, parse } from 'date-fns';
import { CalendarIcon, Loader2, Plus, Trash2, Euro } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Calendar } from '@/components/ui/calendar';
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { createCycle, updateCycle, type Cycle, type CycleInput, type CycleSettings, type ExtraCost, type EventPaymentMethod } from '@/lib/cycles';
import { toast } from 'sonner';

const LESSON_TYPES = ['private', 'duo', 'group', 'kids'] as const;
const CURRENCIES = ['EUR', 'USD', 'GBP'] as const;

interface CycleFormProps {
  cycle?: Cycle | null;
  ownerType: 'trainer' | 'club' | 'academy';
  ownerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (cycle: Cycle) => void;
  trainers?: { id: string; name: string; hourly_rate?: number }[];
  locations?: { id: string; name: string; city: string }[];
  /** Map of location_id -> trainer_ids at that location */
  trainerLocationMap?: Record<string, string[]>;
  /** Hourly rate for trainer-owned cycles (not using trainers array) */
  trainerHourlyRate?: number;
  /** Whether this is a registration (interest collection), cyclus (calendar slot), or event */
  formType?: 'registration' | 'cyclus' | 'event';
}

export default function CycleForm({
  cycle,
  ownerType,
  ownerId,
  open,
  onOpenChange,
  onSuccess,
  trainers = [],
  locations = [],
  trainerLocationMap = {},
  trainerHourlyRate,
  formType = 'cyclus',
}: CycleFormProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [allowSingleBooking, setAllowSingleBooking] = useState<boolean>(
    (cycle?.settings as any)?.allow_single_booking ?? false
  );
  const [paymentTiming, setPaymentTiming] = useState<'upfront' | 'invoice_after_weeks' | 'manual'>(() => {
    const settings = cycle?.settings as any;
    if (settings?.payment_timing) return settings.payment_timing;
    if (settings?.mark_as_paid) return 'manual';
    return 'upfront';
  });
  const [invoiceDelayWeeks, setInvoiceDelayWeeks] = useState<number>(
    (cycle?.settings as any)?.invoice_delay_weeks ?? 2
  );
  const [extraCosts, setExtraCosts] = useState<ExtraCost[]>(
    (cycle?.settings as any)?.extra_costs ?? []
  );
  const [eventPaymentMethod, setEventPaymentMethod] = useState<EventPaymentMethod>(
    (cycle?.settings as any)?.payment_methods ?? 'online'
  );
  const [maxParticipants, setMaxParticipants] = useState<number | ''>(
    (cycle?.settings as any)?.max_participants ?? ''
  );
  const isEdit = !!cycle;
  const isRegistration = formType === 'registration';
  const isEvent = formType === 'event';

  useEffect(() => {
    getRatingSystems().then(setRatingSystems);
  }, []);

  const formSchema = z.object({
    name: (isRegistration || isEvent) ? z.string().min(2) : z.string().optional().default(''),
    description: z.string().optional().default(''),
    start_date: z.date(),
    end_date: isEvent ? z.date().optional() : z.date().optional(),
    number_of_weeks: isEvent ? z.coerce.number().optional().default(1) : z.coerce.number().min(1).max(52),
    start_time: z.string().default('09:00'),
    end_time: z.string().default('10:00'),
    enrollment_deadline: z.date().optional(),
    lesson_types: isEvent ? z.array(z.string()).optional().default([]) : z.array(z.string()).min(1),
    show_preferred_trainer: z.boolean(),
    max_group_size: z.coerce.number().min(2).max(20).optional(),
    min_group_size: z.coerce.number().min(1).max(20).optional(),
    assigned_trainer_id: z.string().optional(),
    min_skill_rating: z.coerce.number().min(0).optional().or(z.literal('')),
    max_skill_rating: z.coerce.number().min(0).optional().or(z.literal('')),
    rating_system: z.string().optional(),
    applicable_trainer_ids: z.array(z.string()).optional(),
    location_id: z.string().optional(),
    price_per_session: z.coerce.number().min(0).optional().or(z.literal('')),
    total_price: z.coerce.number().min(0).optional().or(z.literal('')),
    currency: z.string().default('EUR'),
  }).refine(data => !data.min_group_size || !data.max_group_size || data.min_group_size <= data.max_group_size, {
    message: 'Min group size must be ≤ max group size',
    path: ['min_group_size'],
  });

  type FormValues = z.infer<typeof formSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: cycle?.name || '',
      description: cycle?.description || '',
      start_date: cycle ? new Date(cycle.start_date) : new Date(),
      end_date: cycle?.end_date ? new Date(cycle.end_date) : undefined,
      number_of_weeks: cycle ? Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date)))) : 10,
      start_time: (cycle?.settings as any)?.start_time || '09:00',
      end_time: (cycle?.settings as any)?.end_time || '10:00',
      enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
      lesson_types: cycle?.settings?.lesson_types || (isEvent ? [] : ['private', 'duo', 'group']),
      show_preferred_trainer: cycle?.settings?.show_preferred_trainer ?? (ownerType === 'academy'),
      max_group_size: cycle?.settings?.max_group_size || 4,
      min_group_size: cycle?.settings?.min_group_size || 1,
      assigned_trainer_id: cycle?.settings?.assigned_trainer_id || '',
      min_skill_rating: cycle?.settings?.min_skill_rating ?? '',
      max_skill_rating: cycle?.settings?.max_skill_rating ?? '',
      rating_system: cycle?.settings?.rating_system || 'knltb',
      applicable_trainer_ids: cycle?.settings?.applicable_trainer_ids || [],
      location_id: cycle?.location_id || '',
      price_per_session: cycle?.price_per_session ?? '',
      total_price: cycle?.total_price ?? '',
      currency: cycle?.currency || 'EUR',
    },
  });

  // Reset form when cycle prop changes (e.g. opening edit dialog)
  useEffect(() => {
    if (open) {
      form.reset({
        name: cycle?.name || '',
        description: cycle?.description || '',
        start_date: cycle ? new Date(cycle.start_date) : new Date(),
        end_date: cycle?.end_date ? new Date(cycle.end_date) : undefined,
        number_of_weeks: cycle ? Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date)))) : 10,
        start_time: (cycle?.settings as any)?.start_time || '09:00',
        end_time: (cycle?.settings as any)?.end_time || '10:00',
        enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
        lesson_types: cycle?.settings?.lesson_types || (isEvent ? [] : ['private', 'duo', 'group']),
        show_preferred_trainer: cycle?.settings?.show_preferred_trainer ?? (ownerType === 'academy'),
        max_group_size: cycle?.settings?.max_group_size || 4,
        min_group_size: cycle?.settings?.min_group_size || 1,
        assigned_trainer_id: cycle?.settings?.assigned_trainer_id || '',
        min_skill_rating: cycle?.settings?.min_skill_rating ?? '',
        max_skill_rating: cycle?.settings?.max_skill_rating ?? '',
        rating_system: cycle?.settings?.rating_system || 'knltb',
        applicable_trainer_ids: cycle?.settings?.applicable_trainer_ids || [],
        location_id: cycle?.location_id || '',
        price_per_session: cycle?.price_per_session ?? '',
        total_price: cycle?.total_price ?? '',
        currency: cycle?.currency || 'EUR',
      });
      setAllowSingleBooking((cycle?.settings as any)?.allow_single_booking ?? false);
      const settings = cycle?.settings as any;
      if (settings?.payment_timing) {
        setPaymentTiming(settings.payment_timing);
      } else if (settings?.mark_as_paid) {
        setPaymentTiming('manual');
      } else {
        setPaymentTiming('upfront');
      }
      setInvoiceDelayWeeks(settings?.invoice_delay_weeks ?? 2);
      setExtraCosts((cycle?.settings as any)?.extra_costs ?? []);
      setEventPaymentMethod((cycle?.settings as any)?.payment_methods ?? 'online');
      setMaxParticipants((cycle?.settings as any)?.max_participants ?? '');
    }
  }, [cycle, open]);

  // Clear selected trainers when location changes (but not on initial form reset)
  const watchedLocationId = form.watch('location_id');
  const prevLocationRef = React.useRef(watchedLocationId);
  useEffect(() => {
    if (prevLocationRef.current !== undefined && prevLocationRef.current !== watchedLocationId) {
      if (locations.length > 0 && Object.keys(trainerLocationMap).length > 0) {
        form.setValue('applicable_trainer_ids', []);
        form.setValue('assigned_trainer_id', '');
      }
    }
    prevLocationRef.current = watchedLocationId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedLocationId]);

  // Auto-calculate pricing from trainer hourly rate + timeframe + weeks
  const watchedStartTime = form.watch('start_time');
  const watchedEndTime = form.watch('end_time');
  const watchedWeeks = form.watch('number_of_weeks');
  const watchedAssignedTrainer = form.watch('assigned_trainer_id');

  useEffect(() => {
    if (isRegistration || !watchedStartTime || !watchedEndTime || !watchedWeeks) return;

    // Determine hourly rate
    let hourlyRate: number | undefined;
    if (ownerType === 'trainer') {
      hourlyRate = trainerHourlyRate;
    } else if (watchedAssignedTrainer) {
      const selectedTrainer = trainers.find(t => t.id === watchedAssignedTrainer);
      hourlyRate = selectedTrainer?.hourly_rate;
    }

    if (!hourlyRate || hourlyRate <= 0) return;

    try {
      const refDate = new Date(2000, 0, 1);
      const start = parse(watchedStartTime, 'HH:mm', refDate);
      const end = parse(watchedEndTime, 'HH:mm', refDate);
      const durationMinutes = differenceInMinutes(end, start);
      if (durationMinutes <= 0) return;

      const durationHours = durationMinutes / 60;
      const pricePerSession = Math.round(hourlyRate * durationHours * 100) / 100;
      const totalPrice = Math.round(pricePerSession * watchedWeeks * 100) / 100;

      form.setValue('price_per_session', pricePerSession);
      form.setValue('total_price', totalPrice);
    } catch {
      // Invalid time format, skip
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedStartTime, watchedEndTime, watchedWeeks, watchedAssignedTrainer, trainerHourlyRate, ownerType, extraCosts]);

  const onSubmit = async (values: FormValues, andOpen: boolean = false) => {
    setIsSubmitting(true);
    try {
      const settings: CycleSettings = {
        lesson_types: isEvent ? undefined : values.lesson_types as CycleSettings['lesson_types'],
        show_preferred_trainer: values.show_preferred_trainer,
        max_group_size: isEvent ? undefined : values.max_group_size,
        min_group_size: isEvent ? undefined : values.min_group_size,
        assigned_trainer_id: values.assigned_trainer_id || undefined,
        min_skill_rating: values.min_skill_rating ? Number(values.min_skill_rating) : undefined,
        max_skill_rating: values.max_skill_rating ? Number(values.max_skill_rating) : undefined,
        rating_system: values.rating_system || undefined,
        applicable_trainer_ids: values.applicable_trainer_ids,
        start_time: isEvent ? undefined : values.start_time,
        end_time: isEvent ? undefined : values.end_time,
        allow_single_booking: isEvent ? undefined : allowSingleBooking,
        mark_as_paid: isEvent ? (eventPaymentMethod === 'cash') : paymentTiming === 'manual',
        payment_timing: isEvent ? undefined : paymentTiming,
        invoice_delay_weeks: paymentTiming === 'invoice_after_weeks' ? invoiceDelayWeeks : undefined,
        extra_costs: isEvent ? undefined : extraCosts.filter(ec => ec.description && ec.price > 0),
        // Event-specific
        payment_methods: isEvent ? eventPaymentMethod : undefined,
        max_participants: isEvent && maxParticipants ? Number(maxParticipants) : undefined,
      };

      // For cyclus, auto-generate name from day + time
      let cycleName = values.name;
      if (!isRegistration && !isEvent) {
        const dayName = format(values.start_date, 'EEEE');
        cycleName = `${dayName} ${values.start_time}–${values.end_time}`;
      }

      // Calculate end date
      let endDate: string;
      if (isEvent && values.end_date) {
        endDate = format(values.end_date, 'yyyy-MM-dd');
      } else if (isEvent) {
        endDate = format(values.start_date, 'yyyy-MM-dd');
      } else {
        endDate = format(addWeeks(values.start_date, values.number_of_weeks || 10), 'yyyy-MM-dd');
      }

      const input: CycleInput = {
        owner_type: ownerType,
        owner_id: ownerId,
        name: cycleName,
        description: isEvent ? values.description : undefined,
        start_date: format(values.start_date, 'yyyy-MM-dd'),
        end_date: endDate,
        enrollment_deadline: values.enrollment_deadline?.toISOString(),
        settings,
        status: andOpen ? 'open' : (cycle?.status || 'draft'),
        type: formType,
        location_id: values.location_id || null,
        price_per_session: (isRegistration || isEvent) ? null : (values.price_per_session ? Number(values.price_per_session) : null),
        total_price: isEvent ? (values.total_price ? Number(values.total_price) : null) : (isRegistration ? null : (values.total_price ? Number(values.total_price) : null)),
        currency: values.currency,
      };

      let result: Cycle;
      if (isEdit) {
        result = await updateCycle(cycle.id, input);
      } else {
        result = await createCycle(input);
      }

      toast.success(isEdit ? 'Cycle updated' : 'Cycle created');
      onSuccess?.(result);
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error saving cycle:', error);
      toast.error(error.message || 'Failed to save cycle');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-hidden p-0">
        <div className="overflow-y-auto max-h-[90vh] p-6">
        <DialogHeader>
          <DialogTitle>
            {isEdit 
              ? t('editCycle') 
              : isRegistration 
                ? t('createRegistration', 'Create Registration')
                : t('createCycle')}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => onSubmit(v, false))} className="space-y-4">
            {isRegistration && (
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.name')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={t('form.namePlaceholder')} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="start_date"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t('form.startDate')}</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              'w-full pl-3 text-left font-normal',
                              !field.value && 'text-muted-foreground'
                            )}
                          >
                            {field.value ? format(field.value, 'PPP') : 'Pick date'}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="number_of_weeks"
                render={({ field }) => {
                  const startDate = form.watch('start_date');
                  const computedEnd = startDate && field.value ? addWeeks(startDate, field.value) : null;
                  return (
                    <FormItem className="flex flex-col">
                      <FormLabel>{t('form.numberOfWeeks')}</FormLabel>
                      <FormControl>
                        <Input type="number" min={1} max={52} {...field} />
                      </FormControl>
                      {computedEnd && (
                        <p className="text-xs text-muted-foreground">
                          {t('form.endsOn', { date: format(computedEnd, 'PPP') })}
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>

            {/* Timeframe - only for cyclus */}
            {!isRegistration && (
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="start_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.startTime', 'Start Time')}</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="end_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.endTime', 'End Time')}</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            )}

            <FormField
              control={form.control}
              name="enrollment_deadline"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>{t('form.enrollmentDeadline')}</FormLabel>
                  <Popover>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant="outline"
                          className={cn(
                            'w-full pl-3 text-left font-normal',
                            !field.value && 'text-muted-foreground'
                          )}
                        >
                          {field.value ? format(field.value, 'PPP') : 'No deadline'}
                          <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={field.value}
                        onSelect={field.onChange}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Location Picker - for academies/clubs with locations, or trainers */}
            {locations.length > 0 ? (
              <FormField
                control={form.control}
                name="location_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.location')}</FormLabel>
                    <Select value={field.value || ''} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('form.selectLocation')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {locations.map(loc => (
                          <SelectItem key={loc.id} value={loc.id}>
                            {loc.name} ({loc.city})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">
                      {ownerType === 'trainer'
                        ? t('form.locationHelpTrainer', 'You can add more locations in your profile settings.')
                        : t('form.locationHelp')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <div className="rounded-lg border p-3">
                <p className="text-sm text-muted-foreground">
                  {t('form.noLocations', 'No locations connected to your profile yet.')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {ownerType === 'trainer'
                    ? t('form.addLocationsHintTrainer', 'Add locations in your profile to show where lessons take place.')
                    : t('form.addLocationsHint', 'Add locations in your settings to associate them with registrations.')}
                </p>
              </div>
            )}

            {/* Assigned Trainer - single select for academy */}
            {ownerType === 'academy' && trainers.length > 0 && (() => {
              const selectedLocationId = form.watch('location_id');
              const filteredTrainers = selectedLocationId && Object.keys(trainerLocationMap).length > 0
                ? trainers.filter(tr => trainerLocationMap[selectedLocationId]?.includes(tr.id))
                : trainers;

              if (!selectedLocationId && locations.length > 0) return null;

              return (
                <FormField
                  control={form.control}
                  name="assigned_trainer_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('form.assignedTrainer', 'Assigned Trainer')}</FormLabel>
                      <Select value={field.value || ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={t('form.selectTrainer', 'Select trainer')} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {filteredTrainers.map(tr => (
                            <SelectItem key={tr.id} value={tr.id}>
                              {tr.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription className="text-xs">
                        {t('form.assignedTrainerHelp', 'The trainer who will give the lessons in this cycle')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              );
            })()}

            {/* Applicable Trainers - for clubs (multi-select) */}
            {ownerType === 'club' && trainers.length > 0 && (() => {
              const selectedLocationId = form.watch('location_id');
              const filteredTrainers = selectedLocationId && Object.keys(trainerLocationMap).length > 0
                ? trainers.filter(tr => trainerLocationMap[selectedLocationId]?.includes(tr.id))
                : trainers;

              if (!selectedLocationId && locations.length > 0) return null;

              return (
                <FormField
                  control={form.control}
                  name="applicable_trainer_ids"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('form.applicableTrainers')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('form.applicableTrainersHelp')}
                      </FormDescription>
                      {filteredTrainers.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-2">
                          {t('form.noTrainersAtLocation', 'No trainers assigned to this location')}
                        </p>
                      ) : (
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          {filteredTrainers.map(trainer => (
                            <div key={trainer.id} className="flex items-center space-x-2">
                              <Checkbox
                                id={`trainer-${trainer.id}`}
                                checked={field.value?.includes(trainer.id)}
                                onCheckedChange={(checked) => {
                                  const current = field.value || [];
                                  if (checked) {
                                    field.onChange([...current, trainer.id]);
                                  } else {
                                    field.onChange(current.filter(id => id !== trainer.id));
                                  }
                                }}
                              />
                              <Label htmlFor={`trainer-${trainer.id}`} className="text-sm font-normal">
                                {trainer.name}
                              </Label>
                            </div>
                          ))}
                        </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              );
            })()}

            {/* Skill Level Requirement */}
            <div className="space-y-3 rounded-lg border p-3">
              <FormLabel className="text-sm font-medium">{t('form.levelRequirement', 'Level Requirement')}</FormLabel>
              <FormField
                control={form.control}
                name="rating_system"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">{t('form.ratingSystem', 'Rating System')}</FormLabel>
                    <Select value={field.value || 'knltb'} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="h-9">
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
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="min_skill_rating"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">{t('form.minLevel', 'Min Level')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.1"
                          placeholder={t('form.minLevelPlaceholder', 'e.g. 3.0')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="max_skill_rating"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">{t('form.maxLevel', 'Max Level')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.1"
                          placeholder={t('form.maxLevelPlaceholder', 'e.g. 5.0')}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormDescription className="text-xs">
                {t('form.levelRequirementHelp', 'Only players within this level range can register')}
              </FormDescription>
              </div>




            {/* Pricing - only for cyclus */}
            {!isRegistration && (
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <FormLabel className="text-sm font-medium">{t('form.pricing')}</FormLabel>
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-20 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.map(currency => (
                          <SelectItem key={currency} value={currency}>
                            {currency}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="price_per_session"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">{t('form.pricePerSession')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder="0.00"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="total_price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">{t('form.totalPrice')}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder="0.00"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Pricing breakdown when extra costs exist */}
              {(() => {
                const ecTotal = extraCosts.reduce((sum, ec) => sum + (ec.price || 0), 0);
                const weeks = form.watch('number_of_weeks') || 0;
                const totalExtraCosts = Math.round(ecTotal * weeks * 100) / 100;
                const baseTotal = form.watch('total_price') || 0;
                const grandTotal = Math.round((Number(baseTotal) + totalExtraCosts) * 100) / 100;
                if (ecTotal <= 0) return null;
                return (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('form.totalPrice')}</span>
                      <span>€{Number(baseTotal).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('form.extraCosts')} ({weeks}x €{ecTotal.toFixed(2)})</span>
                      <span>€{totalExtraCosts.toFixed(2)}</span>
                    </div>
                    <div className="border-t pt-1 flex justify-between font-semibold">
                      <span>Total</span>
                      <span>€{grandTotal.toFixed(2)}</span>
                    </div>
                  </div>
                );
              })()}

              {/* Allow single booking toggle */}
              <div className="flex flex-row items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label className="text-sm">{t('form.allowSingleBooking')}</Label>
                  <p className="text-xs text-muted-foreground">{t('form.allowSingleBookingHelp')}</p>
                </div>
                <Switch
                  checked={allowSingleBooking}
                  onCheckedChange={setAllowSingleBooking}
                />
              </div>

              {/* Payment Timing selector */}
              {!isRegistration && (
                <div className="space-y-3 rounded-lg border p-3">
                  <Label className="text-sm font-medium">{t('form.paymentTiming')}</Label>
                  <p className="text-xs text-muted-foreground">{t('form.paymentTimingHelp')}</p>
                  
                  <div className="space-y-2">
                    {/* Upfront */}
                    <label className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                      paymentTiming === 'upfront' && "border-primary bg-primary/5"
                    )}>
                      <input
                        type="radio"
                        name="payment_timing"
                        value="upfront"
                        checked={paymentTiming === 'upfront'}
                        onChange={() => setPaymentTiming('upfront')}
                        className="mt-1"
                      />
                      <div className="space-y-0.5">
                        <span className="text-sm font-medium">{t('form.paymentUpfront')}</span>
                        <p className="text-xs text-muted-foreground">{t('form.paymentUpfrontHelp')}</p>
                      </div>
                    </label>
                    
                    {/* Invoice after X weeks */}
                    <label className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                      paymentTiming === 'invoice_after_weeks' && "border-primary bg-primary/5"
                    )}>
                      <input
                        type="radio"
                        name="payment_timing"
                        value="invoice_after_weeks"
                        checked={paymentTiming === 'invoice_after_weeks'}
                        onChange={() => setPaymentTiming('invoice_after_weeks')}
                        className="mt-1"
                      />
                      <div className="space-y-1.5 flex-1">
                        <span className="text-sm font-medium">{t('form.paymentInvoiceAfter')}</span>
                        <p className="text-xs text-muted-foreground">{t('form.paymentInvoiceAfterHelp')}</p>
                        {paymentTiming === 'invoice_after_weeks' && (
                          <div className="flex items-center gap-2 mt-1">
                            <Select value={String(invoiceDelayWeeks)} onValueChange={(v) => setInvoiceDelayWeeks(Number(v))}>
                              <SelectTrigger className="w-20 h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {[1, 2, 3, 4].map(w => (
                                  <SelectItem key={w} value={String(w)}>
                                    {w}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <span className="text-xs text-muted-foreground">{t('form.invoiceDelayWeeks')}</span>
                          </div>
                        )}
                      </div>
                    </label>
                    
                    {/* Manual */}
                    <label className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                      paymentTiming === 'manual' && "border-primary bg-primary/5"
                    )}>
                      <input
                        type="radio"
                        name="payment_timing"
                        value="manual"
                        checked={paymentTiming === 'manual'}
                        onChange={() => setPaymentTiming('manual')}
                        className="mt-1"
                      />
                      <div className="space-y-0.5">
                        <span className="text-sm font-medium">{t('form.paymentManual')}</span>
                        <p className="text-xs text-muted-foreground">{t('form.paymentManualHelp')}</p>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {/* Extra recurring costs */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.extraCosts')}</Label>
                <p className="text-xs text-muted-foreground">{t('form.extraCostsHelp')}</p>
                {extraCosts.map((cost, index) => (
                  <div key={index} className="grid grid-cols-[1fr_8rem_auto] items-center gap-3">
                    <Input
                      placeholder={t('form.costDescription')}
                      value={cost.description}
                      onChange={(e) => {
                        const updated = [...extraCosts];
                        updated[index] = { ...updated[index], description: e.target.value };
                        setExtraCosts(updated);
                      }}
                    />
                    <div className="relative w-28">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="0.00"
                        value={cost.price || ''}
                        onChange={(e) => {
                          const updated = [...extraCosts];
                          updated[index] = { ...updated[index], price: parseFloat(e.target.value) || 0 };
                          setExtraCosts(updated);
                        }}
                        className="pl-7"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setExtraCosts(extraCosts.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setExtraCosts([...extraCosts, { description: '', price: 0 }])}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('form.addCost')}
                </Button>
              </div>

              <FormDescription className="text-xs">
                {t('form.pricingHelp')}
              </FormDescription>
            </div>
            )}

            <FormField
              control={form.control}
              name="lesson_types"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.lessonTypes')}</FormLabel>
                  <div className="grid grid-cols-2 gap-2">
                    {LESSON_TYPES.map(type => (
                      <div key={type} className="flex items-center space-x-2">
                        <Checkbox
                          id={`type-${type}`}
                          checked={field.value.includes(type)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              field.onChange([...field.value, type]);
                            } else {
                              field.onChange(field.value.filter(t => t !== type));
                            }
                          }}
                        />
                        <Label htmlFor={`type-${type}`} className="text-sm font-normal">
                          {t(`application.form.lessonTypes.${type}`)}
                        </Label>
                      </div>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            {ownerType === 'academy' && isRegistration && (
              <FormField
                control={form.control}
                name="show_preferred_trainer"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>{t('form.showPreferredTrainer')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('form.showPreferredTrainerHelp')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="min_group_size"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.minGroupSize', 'Min Group Size')}</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" min={1} max={20} />
                    </FormControl>
                    <FormDescription className="text-xs">
                      {t('form.minGroupSizeHelp', 'Minimum players required per session')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="max_group_size"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.maxGroupSize')}</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" min={2} max={20} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>


            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                {t('common:cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('form.save')}
              </Button>
              {!isEdit && (
                <Button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => form.handleSubmit((v) => onSubmit(v, true))()}
                >
                  {t('form.saveAndOpen')}
                </Button>
              )}
            </DialogFooter>
          </form>
        </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
