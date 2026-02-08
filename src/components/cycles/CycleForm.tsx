import React, { useState, useEffect } from 'react';
import { getRatingSystems, type RatingSystemConfig } from '@/lib/ratingSystems';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format, differenceInWeeks, addWeeks } from 'date-fns';
import { CalendarIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
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
import { createCycle, updateCycle, type Cycle, type CycleInput, type CycleSettings } from '@/lib/cycles';
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
  trainers?: { id: string; name: string }[];
  locations?: { id: string; name: string; city: string }[];
  /** Map of location_id -> trainer_ids at that location */
  trainerLocationMap?: Record<string, string[]>;
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
}: CycleFormProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const isEdit = !!cycle;

  useEffect(() => {
    getRatingSystems().then(setRatingSystems);
  }, []);

  const formSchema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    start_date: z.date(),
    number_of_weeks: z.coerce.number().min(1).max(52),
    enrollment_deadline: z.date().optional(),
    lesson_types: z.array(z.string()).min(1),
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
      number_of_weeks: cycle ? Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date)))) : 10,
      enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
      lesson_types: cycle?.settings?.lesson_types || ['private', 'duo', 'group'],
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
        number_of_weeks: cycle ? Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date)))) : 10,
        enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
        lesson_types: cycle?.settings?.lesson_types || ['private', 'duo', 'group'],
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

  const onSubmit = async (values: FormValues, andOpen: boolean = false) => {
    setIsSubmitting(true);
    try {
      const settings: CycleSettings = {
        lesson_types: values.lesson_types as CycleSettings['lesson_types'],
        show_preferred_trainer: values.show_preferred_trainer,
        max_group_size: values.max_group_size,
        min_group_size: values.min_group_size,
        assigned_trainer_id: values.assigned_trainer_id || undefined,
        min_skill_rating: values.min_skill_rating ? Number(values.min_skill_rating) : undefined,
        max_skill_rating: values.max_skill_rating ? Number(values.max_skill_rating) : undefined,
        rating_system: values.rating_system || undefined,
        applicable_trainer_ids: values.applicable_trainer_ids,
      };

      const input: CycleInput = {
        owner_type: ownerType,
        owner_id: ownerId,
        name: values.name,
        description: values.description,
        start_date: format(values.start_date, 'yyyy-MM-dd'),
        end_date: format(addWeeks(values.start_date, values.number_of_weeks), 'yyyy-MM-dd'),
        enrollment_deadline: values.enrollment_deadline?.toISOString(),
        settings,
        status: andOpen ? 'open' : (cycle?.status || 'draft'),
        location_id: values.location_id || null,
        price_per_session: values.price_per_session ? Number(values.price_per_session) : null,
        total_price: values.total_price ? Number(values.total_price) : null,
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
            {isEdit ? t('editCycle') : t('createCycle')}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => onSubmit(v, false))} className="space-y-4">
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

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('form.description')}</FormLabel>
                  <FormControl>
                    <RichTextEditor
                      value={field.value || ''}
                      onChange={field.onChange}
                      placeholder={t('form.descriptionPlaceholder')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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

            {/* Location Picker - for academies/clubs with locations */}
            {locations.length > 0 && (
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
                      {t('form.locationHelp')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
              <FormDescription className="text-xs">
                {t('form.pricingHelp')}
              </FormDescription>
            </div>

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

            {ownerType === 'academy' && (
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
