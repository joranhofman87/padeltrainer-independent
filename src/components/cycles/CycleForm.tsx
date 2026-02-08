import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { CalendarIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
}: CycleFormProps) {
  const { t } = useTranslation('cycles');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isEdit = !!cycle;

  const formSchema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    start_date: z.date(),
    end_date: z.date(),
    enrollment_deadline: z.date().optional(),
    lesson_types: z.array(z.string()).min(1),
    show_preferred_trainer: z.boolean(),
    max_group_size: z.coerce.number().min(2).max(20).optional(),
    applicable_trainer_ids: z.array(z.string()).optional(),
    location_id: z.string().optional(),
    price_per_session: z.coerce.number().min(0).optional().or(z.literal('')),
    total_price: z.coerce.number().min(0).optional().or(z.literal('')),
    currency: z.string().default('EUR'),
  }).refine(data => data.end_date > data.start_date, {
    message: 'End date must be after start date',
    path: ['end_date'],
  });

  type FormValues = z.infer<typeof formSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: cycle?.name || '',
      description: cycle?.description || '',
      start_date: cycle ? new Date(cycle.start_date) : new Date(),
      end_date: cycle ? new Date(cycle.end_date) : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
      lesson_types: cycle?.settings?.lesson_types || ['private', 'duo', 'group'],
      show_preferred_trainer: cycle?.settings?.show_preferred_trainer ?? (ownerType === 'academy'),
      max_group_size: cycle?.settings?.max_group_size || 4,
      applicable_trainer_ids: cycle?.settings?.applicable_trainer_ids || [],
      location_id: cycle?.location_id || '',
      price_per_session: cycle?.price_per_session ?? '',
      total_price: cycle?.total_price ?? '',
      currency: cycle?.currency || 'EUR',
    },
  });

  const onSubmit = async (values: FormValues, andOpen: boolean = false) => {
    setIsSubmitting(true);
    try {
      const settings: CycleSettings = {
        lesson_types: values.lesson_types as CycleSettings['lesson_types'],
        show_preferred_trainer: values.show_preferred_trainer,
        max_group_size: values.max_group_size,
        applicable_trainer_ids: values.applicable_trainer_ids,
      };

      const input: CycleInput = {
        owner_type: ownerType,
        owner_id: ownerId,
        name: values.name,
        description: values.description,
        start_date: format(values.start_date, 'yyyy-MM-dd'),
        end_date: format(values.end_date, 'yyyy-MM-dd'),
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
                    <Textarea 
                      {...field} 
                      placeholder={t('form.descriptionPlaceholder')}
                      rows={3}
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
                name="end_date"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t('form.endDate')}</FormLabel>
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

            {/* Pricing Section */}
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

            {(ownerType === 'club' || ownerType === 'academy') && trainers.length > 0 && (
              <FormField
                control={form.control}
                name="applicable_trainer_ids"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.applicableTrainers')}</FormLabel>
                    <FormDescription className="text-xs">
                      {t('form.applicableTrainersHelp')}
                    </FormDescription>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {trainers.map(trainer => (
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
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

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
