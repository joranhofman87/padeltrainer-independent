import React, { useState, useEffect, useRef, useCallback } from 'react';
import { logger } from '@/lib/logger';
import { getRatingSystems, type RatingSystemConfig } from '@/lib/ratingSystems';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format, differenceInWeeks, addWeeks, differenceInMinutes, parse } from 'date-fns';
import { CalendarIcon, Loader2, Plus, Trash2 } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { MiniRichTextEditor } from '@/components/ui/mini-rich-text-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
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
// Dialog imports removed — component now renders inline on a dedicated page
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import { createCycle, updateCycle, type Cycle, type CycleInput, type CycleSettings, type ExtraCost, type EventPaymentMethod, type PriceTableRow, type CyclusOption } from '@/lib/cycles';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import DayAvailabilityPicker, { type DayAvailability } from './DayAvailabilityPicker';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { toast } from 'sonner';

const LESSON_TYPES = ['private', 'duo', 'group3', 'group4', 'kids'] as const;
const CURRENCIES = ['EUR', 'USD', 'GBP'] as const;

// U-09 draft persistence: bump the version whenever the persisted shape changes
// so stale drafts are silently discarded instead of mis-restored.
const CYCLE_FORM_DRAFT_VERSION = 1;
const CYCLE_FORM_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CycleFormDraft {
  v: number;
  savedAt: number;
  /** react-hook-form values; Dates are serialized to ISO strings by JSON. */
  values: Record<string, unknown>;
  terms?: string;
  pricingNote?: string;
  extraCosts?: ExtraCost[];
  priceTable?: PriceTableRow[];
  priceColumns?: string[];
  cyclusOptions?: CyclusOption[];
  availableDays?: DayAvailability;
}

interface CycleFormProps {
  cycle?: Cycle | null;
  ownerType: 'trainer' | 'club' | 'academy';
  ownerId: string;
  onSuccess?: (cycle: Cycle) => void;
  onCancel?: () => void;
  trainers?: { id: string; name: string; hourly_rate?: number }[];
  locations?: { id: string; name: string; city: string }[];
  /** Map of location_id -> trainer_ids at that location */
  trainerLocationMap?: Record<string, string[]>;
  /** Hourly rate for trainer-owned cycles (not using trainers array) */
  trainerHourlyRate?: number;
  /** Whether this is a registration (interest collection), cyclus (calendar slot), or event */
  formType?: 'registration' | 'cyclus' | 'event';
  /** When set, locks the rating system selector to this value */
  trainerRatingSystem?: string | null;
}

export default function CycleForm({
  cycle,
  ownerType,
  ownerId,
  onSuccess,
  onCancel,
  trainers = [],
  locations = [],
  trainerLocationMap = {},
  trainerHourlyRate,
  formType = 'cyclus',
  trainerRatingSystem: fixedRatingSystem,
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
  const [splitPayment, setSplitPayment] = useState<boolean>(
    (cycle?.settings as any)?.split_payment ?? false
  );
  const [extraCosts, setExtraCosts] = useState<ExtraCost[]>(
    (cycle?.settings as any)?.extra_costs ?? []
  );
  const [eventPaymentMethod, setEventPaymentMethod] = useState<EventPaymentMethod>(
    (cycle?.settings as any)?.payment_methods ?? 'online'
  );
  // Registration cycles: 'invoice_later' = existing finalize invoicing; 'online'/'both'
  // = charge the selected package at sign-up (persisted as settings.payment_methods).
  const [registrationChargeMode, setRegistrationChargeMode] = useState<'invoice_later' | 'online' | 'both'>(() => {
    const pm = (cycle?.settings as { payment_methods?: string } | null | undefined)?.payment_methods;
    return pm === 'online' ? 'online' : pm === 'both' ? 'both' : 'invoice_later';
  });
  const [maxParticipants, setMaxParticipants] = useState<number | ''>(
    (cycle?.settings as any)?.max_participants ?? ''
  );
  const [terms, setTerms] = useState<string>(cycle?.terms || '');
  const [priceTable, setPriceTable] = useState<PriceTableRow[]>(cycle?.price_table || []);
  const [priceColumns, setPriceColumns] = useState<string[]>(
    (cycle?.settings as any)?.price_columns ?? []
  );
  const [cyclusOptions, setCyclusOptions] = useState<CyclusOption[]>(
    (cycle?.settings as any)?.cyclus_options ?? []
  );
  const [durationOptions, setDurationOptions] = useState<number[]>(
    (cycle?.settings as any)?.duration_options ?? []
  );
  const [pricesIncludeVat, setPricesIncludeVat] = useState<boolean>(
    (cycle?.settings as any)?.prices_include_vat ?? true
  );
  const [pricingNote, setPricingNote] = useState<string>(
    (cycle?.settings as any)?.pricing_note ?? ''
  );
  const [newDurationWeeks, setNewDurationWeeks] = useState<number | ''>('');
  const STANDARD_DURATIONS = [30, 45, 60, 90, 120] as const;
  const [availableDurations, setAvailableDurations] = useState<number[]>(
    (cycle?.settings as any)?.available_duration_minutes ?? [...STANDARD_DURATIONS]
  );
  const [customDurationInput, setCustomDurationInput] = useState<number | ''>('');
  const [customLessonType1, setCustomLessonType1] = useState<string>(
    (cycle?.settings as any)?.custom_lesson_types?.[0] ?? ''
  );
  const [customLessonType2, setCustomLessonType2] = useState<string>(
    (cycle?.settings as any)?.custom_lesson_types?.[1] ?? ''
  );
  const [availableDays, setAvailableDays] = useState<DayAvailability>(
    (cycle?.settings as any)?.available_days ?? {}
  );
  const isEdit = !!cycle?.id;
  const isRegistration = formType === 'registration';
  const isEvent = formType === 'event';
  // True = end_date is user-authoritative (loaded from a saved cycle, or manually
  // picked) and must NOT be overwritten by the start+weeks auto-sync below.
  const customEndDateRef = useRef(!!cycle?.end_date);

  useEffect(() => {
    getRatingSystems().then(setRatingSystems);
  }, []);

  // Sync fixed rating system into form
  useEffect(() => {
    if (fixedRatingSystem) {
      form.setValue('rating_system', fixedRatingSystem);
    }
  }, [fixedRatingSystem]);

  const formSchema = z.object({
    name: (isRegistration || isEvent) ? z.string().min(2) : z.string().optional().default(''),
    description: z.string().optional().default(''),
    is_always_open: z.boolean().default(false),
    start_date: z.date().optional(),
    end_date: isEvent ? z.date().optional() : z.date().optional(),
    number_of_weeks: isEvent ? z.coerce.number().optional().default(1) : z.coerce.number().min(1).max(52).optional(),
    start_time: z.string().default('09:00'),
    end_time: z.string().default('10:00'),
    enrollment_deadline: z.date().optional(),
    lesson_types: isEvent ? z.array(z.string()).optional().default([]) : z.array(z.string()).min(1),
    show_preferred_trainer: z.boolean(),
    show_price_indication: z.boolean(),
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
    success_message: z.string().optional().default(''),
    confirmation_email_text: z.string().optional().default(''),
    notify_admin_on_submission: z.boolean().default(true),
    notify_admin_emails: z.string().optional().default(''),
  }).refine(data => !data.min_group_size || !data.max_group_size || data.min_group_size <= data.max_group_size, {
    message: 'Min group size must be ≤ max group size',
    path: ['min_group_size'],
  }).refine(data => data.is_always_open || !!data.start_date, {
    message: 'Start date is required',
    path: ['start_date'],
    // A training cycle without a location is the root cause of players showing no club
    // (the slot inherits the cycle's location). Require one when clubs are available;
    // events/registrations are exempt.
  }).refine(data => isEvent || isRegistration || locations.length === 0 || !!data.location_id, {
    message: t('form.locationRequired', 'Select a training location so players show the right club.'),
    path: ['location_id'],
  });

  type FormValues = z.infer<typeof formSchema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: cycle?.name || '',
      description: cycle?.description || '',
      is_always_open: cycle?.is_always_open ?? false,
      start_date: cycle?.start_date ? new Date(cycle.start_date) : (cycle?.is_always_open ? undefined : new Date()),
      end_date: cycle?.end_date ? new Date(cycle.end_date) : undefined,
      number_of_weeks: cycle?.start_date && cycle?.end_date ? Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date)))) : 10,
      start_time: (cycle?.settings as any)?.start_time || '09:00',
      end_time: (cycle?.settings as any)?.end_time || '10:00',
      enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
      lesson_types: cycle?.settings?.lesson_types || (isEvent ? [] : ['private', 'duo', 'group3', 'group4']),
      show_preferred_trainer: cycle?.settings?.show_preferred_trainer ?? (ownerType === 'academy'),
      show_price_indication: (cycle?.settings as any)?.show_price_indication ?? true,
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
      success_message: (cycle?.settings as any)?.success_message || '',
      confirmation_email_text: (cycle?.settings as any)?.confirmation_email_text || '',
      notify_admin_on_submission: (cycle?.settings as any)?.notify_admin_on_submission ?? true,
      notify_admin_emails: (cycle?.settings as any)?.notify_admin_emails || '',
    },
  });

  // Reset form when cycle prop changes (e.g. opening edit dialog)
  useEffect(() => {
    if (open) {
      form.reset({
        name: cycle?.name || '',
        description: cycle?.description || '',
        is_always_open: cycle?.is_always_open ?? false,
        start_date: cycle?.start_date ? new Date(cycle.start_date) : (cycle?.is_always_open ? undefined : new Date()),
        end_date: cycle?.end_date ? new Date(cycle.end_date) : undefined,
        number_of_weeks: cycle?.start_date && cycle?.end_date ? Math.max(1, Math.round(differenceInWeeks(new Date(cycle.end_date), new Date(cycle.start_date)))) : 10,
        start_time: (cycle?.settings as any)?.start_time || '09:00',
        end_time: (cycle?.settings as any)?.end_time || '10:00',
        enrollment_deadline: cycle?.enrollment_deadline ? new Date(cycle.enrollment_deadline) : undefined,
        lesson_types: cycle?.settings?.lesson_types || (isEvent ? [] : ['private', 'duo', 'group3', 'group4']),
        show_preferred_trainer: cycle?.settings?.show_preferred_trainer ?? (ownerType === 'academy'),
        show_price_indication: (cycle?.settings as any)?.show_price_indication ?? true,
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
        success_message: (cycle?.settings as any)?.success_message || '',
        confirmation_email_text: (cycle?.settings as any)?.confirmation_email_text || '',
        notify_admin_on_submission: (cycle?.settings as any)?.notify_admin_on_submission ?? true,
        notify_admin_emails: (cycle?.settings as any)?.notify_admin_emails || '',
      });
      // Keep the auto-sync guard in step with the freshly-loaded cycle: a saved
      // end date is authoritative, so the start+weeks effect must not clobber it.
      customEndDateRef.current = !!cycle?.end_date;
      setAllowSingleBooking((cycle?.settings as any)?.allow_single_booking ?? false);
      setSplitPayment((cycle?.settings as any)?.split_payment ?? false);
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
      const regPm = (cycle?.settings as { payment_methods?: string } | null | undefined)?.payment_methods;
      setRegistrationChargeMode(regPm === 'online' ? 'online' : regPm === 'both' ? 'both' : 'invoice_later');
      setMaxParticipants((cycle?.settings as any)?.max_participants ?? '');
      setTerms(cycle?.terms || '');
      setPriceTable(cycle?.price_table || []);
      setPriceColumns((cycle?.settings as any)?.price_columns ?? []);
      setCyclusOptions((cycle?.settings as any)?.cyclus_options ?? []);
      setDurationOptions((cycle?.settings as any)?.duration_options ?? []);
      setPricesIncludeVat((cycle?.settings as any)?.prices_include_vat ?? true);
      setPricingNote((cycle?.settings as any)?.pricing_note ?? '');
      setAvailableDurations((cycle?.settings as any)?.available_duration_minutes ?? [...STANDARD_DURATIONS]);
      setCustomDurationInput('');
      setAvailableDays((cycle?.settings as any)?.available_days ?? {});
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
  const watchedStartDate = form.watch('start_date');
  const watchedAlwaysOpen = form.watch('is_always_open');

  // Auto-sync end_date from start_date + weeks (for non-event types)
  useEffect(() => {
    if (isEvent || customEndDateRef.current) return;
    if (watchedStartDate && watchedWeeks && watchedWeeks > 0) {
      const computed = addWeeks(watchedStartDate, watchedWeeks);
      form.setValue('end_date', computed);
    }
  }, [watchedStartDate, watchedWeeks, isEvent]);

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

  // U-09: persist a debounced draft so a session-expiry redirect, crash, or tab
  // close doesn't destroy long-form input. Cleared on successful save.
  const draftKey = `cycle-form-draft:${ownerType}:${ownerId}:${cycle?.id ?? `new-${formType}`}`;
  const draftWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasDraftChanges, setHasDraftChanges] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<CycleFormDraft | null>(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CycleFormDraft;
      if (
        parsed?.v !== CYCLE_FORM_DRAFT_VERSION ||
        typeof parsed.savedAt !== 'number' ||
        typeof parsed.values !== 'object' ||
        parsed.values === null
      ) return null;
      if (Date.now() - parsed.savedAt > CYCLE_FORM_DRAFT_MAX_AGE_MS) return null;
      return parsed;
    } catch {
      return null;
    }
  });

  const scheduleDraftWrite = useCallback(() => {
    setHasDraftChanges(true);
    if (draftWriteTimer.current) clearTimeout(draftWriteTimer.current);
    draftWriteTimer.current = setTimeout(() => {
      try {
        const draft: CycleFormDraft = {
          v: CYCLE_FORM_DRAFT_VERSION,
          savedAt: Date.now(),
          values: form.getValues() as Record<string, unknown>,
          terms,
          pricingNote,
          extraCosts,
          priceTable,
          priceColumns,
          cyclusOptions,
          availableDays,
        };
        localStorage.setItem(draftKey, JSON.stringify(draft));
      } catch {
        // Storage unavailable or full — the beforeunload guard still applies
      }
    }, 1000);
  }, [form, draftKey, terms, pricingNote, extraCosts, priceTable, priceColumns, cyclusOptions, availableDays]);

  useEffect(() => {
    const subscription = form.watch(() => {
      // Gated on isDirty so programmatic setValue calls (auto end_date/pricing
      // sync on mount) don't create a draft before the user typed anything.
      if (form.formState.isDirty) scheduleDraftWrite();
    });
    return () => subscription.unsubscribe();
  }, [form, scheduleDraftWrite]);

  // Aux state lives outside react-hook-form; compare serialized snapshots so the
  // mount-time reset (same content, new array identities) doesn't write a draft.
  const auxSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    let serialized: string;
    try {
      serialized = JSON.stringify({ terms, pricingNote, extraCosts, priceTable, priceColumns, cyclusOptions, availableDays });
    } catch {
      return;
    }
    if (auxSnapshotRef.current !== null && auxSnapshotRef.current !== serialized) {
      scheduleDraftWrite();
    }
    auxSnapshotRef.current = serialized;
  }, [terms, pricingNote, extraCosts, priceTable, priceColumns, cyclusOptions, availableDays, scheduleDraftWrite]);

  useEffect(() => () => {
    if (draftWriteTimer.current) clearTimeout(draftWriteTimer.current);
  }, []);

  const clearDraft = () => {
    if (draftWriteTimer.current) {
      clearTimeout(draftWriteTimer.current);
      draftWriteTimer.current = null;
    }
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // ignore storage errors
    }
    setHasDraftChanges(false);
    setPendingDraft(null);
  };

  const restoreDraft = () => {
    if (!pendingDraft) return;
    try {
      const values: Record<string, unknown> = { ...pendingDraft.values };
      for (const key of ['start_date', 'end_date', 'enrollment_deadline'] as const) {
        const raw = values[key];
        if (typeof raw === 'string') {
          const revived = new Date(raw);
          values[key] = Number.isNaN(revived.getTime()) ? undefined : revived;
        }
      }
      // keepDefaultValues so restored values still count as dirty edits
      form.reset(values as FormValues, { keepDefaultValues: true });
      if (typeof pendingDraft.terms === 'string') setTerms(pendingDraft.terms);
      if (typeof pendingDraft.pricingNote === 'string') setPricingNote(pendingDraft.pricingNote);
      if (Array.isArray(pendingDraft.extraCosts)) setExtraCosts(pendingDraft.extraCosts);
      if (Array.isArray(pendingDraft.priceTable)) setPriceTable(pendingDraft.priceTable);
      if (Array.isArray(pendingDraft.priceColumns)) setPriceColumns(pendingDraft.priceColumns);
      if (Array.isArray(pendingDraft.cyclusOptions)) setCyclusOptions(pendingDraft.cyclusOptions);
      if (pendingDraft.availableDays && typeof pendingDraft.availableDays === 'object') {
        setAvailableDays(pendingDraft.availableDays);
      }
      setHasDraftChanges(true);
    } catch {
      // Corrupt draft — drop it rather than break the form
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // ignore storage errors
      }
    }
    setPendingDraft(null);
  };

  const dismissDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // ignore storage errors
    }
    setPendingDraft(null);
  };

  useUnsavedChangesGuard(form.formState.isDirty || hasDraftChanges);

  const onSubmit = async (values: FormValues, andOpen: boolean = false) => {
    setIsSubmitting(true);
    try {
      const customLessonTypes = [customLessonType1.trim(), customLessonType2.trim()].filter(Boolean);
      const settings: CycleSettings = {
        lesson_types: isEvent ? undefined : values.lesson_types as CycleSettings['lesson_types'],
        custom_lesson_types: !isEvent && customLessonTypes.length > 0 ? customLessonTypes : undefined,
        show_preferred_trainer: values.show_preferred_trainer,
        show_price_indication: values.show_price_indication,
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
        split_payment: isEvent ? undefined : splitPayment,
        extra_costs: isEvent ? undefined : extraCosts.filter(ec => ec.description && ec.price > 0),
        // Event-specific
        payment_methods: isEvent
          ? eventPaymentMethod
          : (isRegistration && registrationChargeMode !== 'invoice_later' ? registrationChargeMode : undefined),
        max_participants: isEvent && maxParticipants ? Number(maxParticipants) : undefined,
        success_message: values.success_message?.trim() || undefined,
        confirmation_email_text: values.confirmation_email_text?.trim() || undefined,
        notify_admin_on_submission: values.notify_admin_on_submission,
        notify_admin_emails: values.notify_admin_emails?.trim() || undefined,
        cyclus_options: isRegistration && cyclusOptions.filter(co => co.label && co.number_of_sessions > 0).length > 0
          ? cyclusOptions.filter(co => co.label && co.number_of_sessions > 0)
          : undefined,
        duration_options: isRegistration && durationOptions.length > 0 ? durationOptions : undefined,
        available_duration_minutes: isRegistration ? availableDurations.sort((a, b) => a - b) : undefined,
        price_columns: priceColumns.length > 0 ? priceColumns : undefined,
        prices_include_vat: pricesIncludeVat,
        pricing_note: pricingNote && pricingNote !== '<p></p>' ? pricingNote : undefined,
        available_days: isRegistration && Object.keys(availableDays).length > 0 ? availableDays : undefined,
      };

      // For cyclus, auto-generate name from day + time
      let cycleName = values.name;
      if (!isRegistration && !isEvent) {
        const dayName = values.start_date ? format(values.start_date, 'EEEE') : '';
        cycleName = `${dayName} ${values.start_time}–${values.end_time}`;
      }

      const alwaysOpen = isRegistration && values.is_always_open;

      // Calculate end date
      let endDate: string | null;
      let startDate: string | null;
      if (alwaysOpen) {
        startDate = null;
        endDate = null;
      } else {
        startDate = values.start_date ? format(values.start_date, 'yyyy-MM-dd') : null;
        if (values.end_date) {
          endDate = format(values.end_date, 'yyyy-MM-dd');
        } else if (isEvent && values.start_date) {
          endDate = format(values.start_date, 'yyyy-MM-dd');
        } else if (values.start_date && values.number_of_weeks) {
          endDate = format(addWeeks(values.start_date, values.number_of_weeks), 'yyyy-MM-dd');
        } else {
          endDate = null;
        }
      }

      const input: CycleInput = {
        owner_type: ownerType,
        owner_id: ownerId,
        name: cycleName,
        description: (isEvent || isRegistration) ? values.description : undefined,
        start_date: startDate,
        end_date: endDate,
        enrollment_deadline: alwaysOpen ? null : values.enrollment_deadline?.toISOString(),
        is_always_open: alwaysOpen,
        settings,
        status: andOpen ? 'open' : (cycle?.status || 'draft'),
        type: formType,
        location_id: values.location_id || null,
        price_per_session: (isRegistration || isEvent) ? null : (values.price_per_session ? Number(values.price_per_session) : null),
        total_price: isEvent ? (values.total_price ? Number(values.total_price) : null) : (isRegistration ? null : (values.total_price ? Number(values.total_price) : null)),
        currency: values.currency,
        terms: terms || null,
        price_table: priceTable.filter(pt => pt.label && (pt.price > 0 || (pt.extra_prices && pt.extra_prices.some(ep => ep.price > 0)))).length > 0
          ? priceTable.filter(pt => pt.label && (pt.price > 0 || (pt.extra_prices && pt.extra_prices.some(ep => ep.price > 0))))
          : null,
      };

      let result: Cycle;
      if (isEdit) {
        result = await updateCycle(cycle.id, input);
      } else {
        result = await createCycle(input);
      }

      clearDraft();
      toast.success(isEdit ? t('form.cycleUpdated', 'Cycle updated') : t('form.cycleCreated', 'Cycle created'));
      onSuccess?.(result);
      // Navigation handled by onSuccess callback
    } catch (error: any) {
      logger.error('Error saving cycle', error instanceof Error ? error : new Error(String(error)), { component: 'CycleForm' });
      toast.error(getFriendlyErrorMessage(error, t('form.saveFailed', 'Failed to save cycle')));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
        {pendingDraft && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
            <span>{t('form.draftFound', 'Niet-opgeslagen concept gevonden. Wil je verdergaan waar je gebleven was?')}</span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={dismissDraft}>
                {t('form.draftDismiss', 'Verwijderen')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={restoreDraft}>
                {t('form.draftRestore', 'Herstellen')}
              </Button>
            </div>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => onSubmit(v, false))} className="space-y-4">
            {(isRegistration || isEvent) && (
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{isRegistration ? t('form.registrationName', 'Registration Name') : t('form.name')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={isRegistration ? t('form.registrationNamePlaceholder', 'e.g., Spring Registration 2026') : t('form.namePlaceholder')} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {/* Event description */}
            {isEvent && (
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.description', 'Description')}</FormLabel>
                    <FormControl>
                      <RichTextEditor value={field.value || ''} onChange={field.onChange} placeholder={t('form.descriptionPlaceholder', 'Describe the event...')} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {/* Registration description */}
            {isRegistration && (
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.description', 'Description')}</FormLabel>
                    <FormControl>
                      <RichTextEditor value={field.value || ''} onChange={field.onChange} placeholder={t('form.registrationDescriptionPlaceholder', 'Describe this registration...')} />
                    </FormControl>
                    <FormDescription className="text-xs">
                      {t('form.registrationDescriptionHelp', 'Visible to players before they apply')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Success message - shown after player submits */}
            {(isRegistration || isEvent) && (
              <FormField
                control={form.control}
                name="success_message"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.successMessage', 'Success Message')}</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder={t('form.successMessagePlaceholder', 'e.g. Thanks for signing up! We will contact you within 2 days.')}
                        rows={3}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      {t('form.successMessageHelp', 'Custom message shown to players after they submit the form. Leave empty for the default message.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Confirmation email text - included in registration confirmation email */}
            {(isRegistration || isEvent) && (
              <FormField
                control={form.control}
                name="confirmation_email_text"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.confirmationEmailText', 'Confirmation Email Text')}</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder={t('form.confirmationEmailTextPlaceholder', 'e.g. Training starts on March 1st. Please bring your own racket.')}
                        rows={3}
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      {t('form.confirmationEmailTextHelp', 'This text is included in the confirmation email sent to players after they register. Leave empty to send a standard confirmation.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Notify admin on new submission */}
            {(isRegistration || isEvent) && (
              <div className="rounded-md border p-4 space-y-3">
                <FormField
                  control={form.control}
                  name="notify_admin_on_submission"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start gap-3">
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>{t('form.notifyAdmin.label', 'Email me on new submissions')}</FormLabel>
                        <FormDescription className="text-xs">
                          {t('form.notifyAdmin.help', 'Send an email notification when a player submits this form.')}
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
                {form.watch('notify_admin_on_submission') && (
                  <FormField
                    control={form.control}
                    name="notify_admin_emails"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('form.notifyAdmin.extraEmails', 'Additional notification emails')}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="alice@example.com, bob@example.com"
                          />
                        </FormControl>
                        <FormDescription className="text-xs">
                          {t('form.notifyAdmin.extraEmailsHelp', 'Comma-separated. Leave empty to only notify the default account owners.')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
            )}



            {/* Always-open toggle: registrations only */}
            {isRegistration && (
              <FormField
                control={form.control}
                name="is_always_open"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start gap-3 rounded-md border p-4">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>{t('form.alwaysOpen.label', 'Open registration (no fixed dates)')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('form.alwaysOpen.help', 'This form stays open until you close it from the registrations list. Players can apply at any time.')}
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            )}

            {!watchedAlwaysOpen && (isEvent ? (
              /* Event: start date + end date */
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
                      <FormLabel>{t('form.endDate', 'End Date')}</FormLabel>
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
                              {field.value ? format(field.value, 'PPP') : t('form.sameAsStart', 'Same as start')}
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
                      <FormDescription className="text-xs">
                        {t('form.endDateHelp', 'Leave empty for a single-day event')}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : (
              /* Registration / Cyclus: start date + number of weeks + end date */
              <>
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
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>{t('form.numberOfWeeks')}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          max={52}
                          {...field}
                          onChange={(e) => {
                            // Editing weeks re-enables the start+weeks auto-fill of end_date.
                            customEndDateRef.current = false;
                            field.onChange(e);
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* End Date picker — auto-filled but manually overridable */}
              <FormField
                control={form.control}
                name="end_date"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t('form.endDate', 'End Date')}</FormLabel>
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
                            {field.value ? format(field.value, 'PPP') : t('form.pickDate', 'Pick date')}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={(date) => {
                            customEndDateRef.current = true;
                            field.onChange(date);
                          }}
                          initialFocus
                          className="pointer-events-auto"
                        />
                      </PopoverContent>
                    </Popover>
                    <p className="text-xs text-muted-foreground">
                      {t('form.endDateHint', 'Automatically set based on weeks. Override to set a specific end date (e.g. last Friday of the cycle).')}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              </>
            ))}

            {/* Timeframe - only for cyclus */}
            {!isRegistration && !isEvent && (
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

            {!watchedAlwaysOpen && (
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
            )}

            {/* Location Picker - for academies/clubs with locations, or trainers */}
            {locations.length > 0 ? (
              <FormField
                control={form.control}
                name="location_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.location')}{!isEvent && !isRegistration ? ' *' : ''}</FormLabel>
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
                        {isRegistration ? t('form.registrationAssignedTrainerHelp', 'The trainer who will give the lessons for this registration') : t('form.assignedTrainerHelp', 'The trainer who will give the lessons in this cycle')}
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
                        {isRegistration ? t('form.registrationApplicableTrainersHelp') : t('form.applicableTrainersHelp')}
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
              {fixedRatingSystem ? (
                <div className="space-y-1">
                  <FormLabel className="text-xs">{t('form.ratingSystem', 'Rating System')}</FormLabel>
                  <p className="text-sm text-muted-foreground">
                    {ratingSystems.find(rs => rs.code === fixedRatingSystem)?.name || fixedRatingSystem}
                  </p>
                </div>
              ) : (
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
              )}
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

            {/* Available Days & Times — for registrations */}
            {isRegistration && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.availableDays', 'Available Days & Times')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('form.availableDaysHelp', 'Select which days and time frames are available for training. Players will only see these options.')}
                </p>
                <DayAvailabilityPicker
                  value={availableDays}
                  onChange={setAvailableDays}
                />
              </div>
            )}

            {/* Terms / Voorwaarden — for registrations and events */}
            {(isRegistration || isEvent) && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.terms', 'Terms (Voorwaarden)')}</Label>
                <Textarea
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  placeholder={t('form.termsPlaceholder', 'Add specific terms and conditions for this registration...')}
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">
                  {t('form.termsHelp', 'These terms are shown to players before they apply. Separate from your general terms.')}
                </p>
              </div>
            )}

            {/* Price Table / Tarieven — for registrations and events */}
            {(isRegistration || isEvent) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{t('form.priceTable', 'Price List (Tarieven)')}</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      const newCol = t('form.defaultColumnName', 'Category') + ` ${priceColumns.length + 1}`;
                      setPriceColumns([...priceColumns, newCol]);
                      // Add extra_prices entry to existing rows
                      setPriceTable(priceTable.map(row => ({
                        ...row,
                        extra_prices: [...(row.extra_prices || []), { column_name: newCol, price: 0 }],
                      })));
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    {t('form.addPriceColumn', 'Add price column')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('form.priceTableHelp', 'Add price rows that players can see before applying')}
                </p>

                {/* VAT toggle — shown above price inputs for clarity */}
                <div className="flex items-center gap-3 pt-1 pb-1">
                  <Switch
                    id="prices-include-vat"
                    checked={pricesIncludeVat}
                    onCheckedChange={setPricesIncludeVat}
                  />
                  <Label htmlFor="prices-include-vat" className="text-sm cursor-pointer">
                    {pricesIncludeVat
                      ? t('form.pricesIncludeVat', 'Prices are including VAT (incl. BTW)')
                      : t('form.pricesExcludeVat', 'Prices are excluding VAT (excl. BTW)')}
                  </Label>
                </div>

                {/* Column headers when extra columns exist */}
                {priceColumns.length > 0 && (
                  <div className={cn("grid items-end gap-2", `grid-cols-[1fr_repeat(${priceColumns.length + 1},6rem)_auto]`)} style={{ gridTemplateColumns: `1fr repeat(${priceColumns.length + 1}, 6rem) auto` }}>
                    <span className="text-xs font-medium text-muted-foreground">{t('form.priceLabel', 'Label')}</span>
                    <span className="text-xs font-medium text-muted-foreground text-center">{t('detail.pricePerSession', 'Price')} {pricesIncludeVat ? t('form.inclVatShort', '(incl.)') : t('form.exclVatShort', '(excl.)')}</span>
                    {priceColumns.map((col, ci) => (
                      <div key={ci} className="flex flex-col gap-0.5">
                        <Input
                          value={col}
                          onChange={(e) => {
                            const oldName = priceColumns[ci];
                            const newName = e.target.value;
                            const updated = [...priceColumns];
                            updated[ci] = newName;
                            setPriceColumns(updated);
                            // Rename in all rows
                            setPriceTable(priceTable.map(row => ({
                              ...row,
                              extra_prices: (row.extra_prices || []).map(ep =>
                                ep.column_name === oldName ? { ...ep, column_name: newName } : ep
                              ),
                            })));
                          }}
                          className="h-7 text-xs text-center"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon" aria-label="Delete"
                          className="h-5 w-5 mx-auto"
                          onClick={() => {
                            const colName = priceColumns[ci];
                            setPriceColumns(priceColumns.filter((_, i) => i !== ci));
                            setPriceTable(priceTable.map(row => ({
                              ...row,
                              extra_prices: (row.extra_prices || []).filter(ep => ep.column_name !== colName),
                            })));
                          }}
                        >
                          <Trash2 className="h-3 w-3 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                    <span />
                  </div>
                )}

                {priceTable.map((row, index) => (
                  <div
                    key={index}
                    className="grid items-center gap-2"
                    style={{ gridTemplateColumns: priceColumns.length > 0 ? `1fr repeat(${priceColumns.length + 1}, 6rem) auto` : '1fr 8rem auto' }}
                  >
                    <Input
                      placeholder={t('form.priceLabel', 'e.g. Group lesson (4 players)')}
                      value={row.label}
                      onChange={(e) => {
                        const updated = [...priceTable];
                        updated[index] = { ...updated[index], label: e.target.value };
                        setPriceTable(updated);
                      }}
                    />
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">€</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="0.00"
                        value={row.price || ''}
                        onChange={(e) => {
                          const updated = [...priceTable];
                          updated[index] = { ...updated[index], price: parseFloat(e.target.value) || 0 };
                          setPriceTable(updated);
                        }}
                        className="pl-6 text-sm"
                      />
                    </div>
                    {priceColumns.map((col, ci) => {
                      const ep = (row.extra_prices || []).find(ep => ep.column_name === col);
                      return (
                        <div key={ci} className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">€</span>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="0.00"
                            value={ep?.price || ''}
                            onChange={(e) => {
                              const updated = [...priceTable];
                              const newPrice = parseFloat(e.target.value) || 0;
                              const existingExtras = updated[index].extra_prices || [];
                              const epIdx = existingExtras.findIndex(x => x.column_name === col);
                              if (epIdx >= 0) {
                                existingExtras[epIdx] = { ...existingExtras[epIdx], price: newPrice };
                              } else {
                                existingExtras.push({ column_name: col, price: newPrice });
                              }
                              updated[index] = { ...updated[index], extra_prices: existingExtras };
                              setPriceTable(updated);
                            }}
                            className="pl-6 text-sm"
                          />
                        </div>
                      );
                    })}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon" aria-label="Delete"
                      onClick={() => setPriceTable(priceTable.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPriceTable([...priceTable, {
                    label: '',
                    price: 0,
                    extra_prices: priceColumns.map(col => ({ column_name: col, price: 0 })),
                  }])}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('form.addPriceRow', 'Add price row')}
                </Button>

                <p className="text-xs text-muted-foreground">
                  {pricesIncludeVat
                    ? t('form.pricesIncludeVatHint', 'Players will see: "All prices include VAT"')
                    : t('form.pricesExcludeVatHint', 'Players will see: "All prices exclude VAT"')}
                </p>

                {/* Pricing note */}
                <div className="space-y-1.5 pt-2">
                  <Label htmlFor="pricing-note" className="text-sm font-medium">
                    {t('form.pricingNote', 'Pricing comment')}
                  </Label>
                  <MiniRichTextEditor
                    value={pricingNote}
                    onChange={setPricingNote}
                    placeholder={t('form.pricingNotePlaceholder', 'e.g. "Family discount available on request"')}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('form.pricingNoteHelp', 'Shown to players below the pricing table. Leave empty to hide.')}
                  </p>
                </div>

                {/* Price Overview Summary */}
                {priceTable.length > 0 && priceTable.some(r => r.price > 0 || (r.extra_prices || []).some(ep => ep.price > 0)) && (
                  <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                    <h4 className="text-sm font-medium text-muted-foreground">{t('form.priceOverview', 'Price Overview')}</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {/* Per lesson columns */}
                      {[
                        { name: t('form.perLesson', 'Per lesson'), getPrice: (row: PriceTableRow) => row.price },
                        ...priceColumns.map(col => ({
                          name: `${col} (${t('form.perLesson', 'per lesson').toLowerCase()})`,
                          getPrice: (row: PriceTableRow) => (row.extra_prices || []).find(ep => ep.column_name === col)?.price || 0,
                        })),
                      ].map((column, ci) => (
                        <div key={`per-${ci}`} className="rounded-md bg-background border p-3 space-y-1.5">
                          <p className="text-xs font-medium text-muted-foreground">{column.name}</p>
                          {priceTable.filter(r => column.getPrice(r) > 0).map((row, ri) => (
                            <div key={ri} className="flex justify-between text-sm">
                              <span className="text-muted-foreground truncate mr-2">{row.label || '—'}</span>
                              <span className="font-medium tabular-nums">{formatCurrency(column.getPrice(row))}</span>
                            </div>
                          ))}
                        </div>
                      ))}

                      {/* Per duration columns */}
                      {(durationOptions.length > 1 ? durationOptions.sort((a, b) => a - b) : (watchedWeeks ? [watchedWeeks] : [])).flatMap(weeks =>
                        [
                          { name: `${weeks} ${t('form.numberOfWeeksColumn', 'weeks')}`, getPrice: (row: PriceTableRow) => row.price, weeks },
                          ...priceColumns.map(col => ({
                            name: `${col} ${weeks} ${t('form.numberOfWeeksColumn', 'weeks')}`,
                            getPrice: (row: PriceTableRow) => (row.extra_prices || []).find(ep => ep.column_name === col)?.price || 0,
                            weeks,
                          })),
                        ].map((column, ci) => (
                          <div key={`w${weeks}-${ci}`} className="rounded-md bg-background border border-primary/20 p-3 space-y-1.5">
                            <p className="text-xs font-medium text-primary">{column.name}</p>
                            {priceTable.filter(r => column.getPrice(r) > 0).map((row, ri) => (
                              <div key={ri} className="flex justify-between text-sm">
                                <span className="text-muted-foreground truncate mr-2">{row.label || '—'}</span>
                                <span className="font-semibold tabular-nums">{formatCurrency(column.getPrice(row) * column.weeks)}</span>
                              </div>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Cyclus Options builder — for registrations only */}
            {isRegistration && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.cyclusOptions', 'Cyclus Options')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('form.cyclusOptionsHelp', 'Define different packages players can choose from (e.g. 5, 10, or 15 lessons)')}
                </p>
                {cyclusOptions.map((opt, index) => (
                  <div key={index} className="grid grid-cols-[1fr_4rem_4rem_5rem_5rem_auto] items-center gap-2">
                    <Input
                      placeholder={t('form.cyclusOptionLabel', 'e.g. Cyclus 5 lessen')}
                      value={opt.label}
                      onChange={(e) => {
                        const updated = [...cyclusOptions];
                        updated[index] = { ...updated[index], label: e.target.value };
                        setCyclusOptions(updated);
                      }}
                    />
                    <Input
                      type="number"
                      min={1}
                      placeholder="#"
                      value={opt.number_of_sessions || ''}
                      onChange={(e) => {
                        const updated = [...cyclusOptions];
                        const sessions = parseInt(e.target.value) || 0;
                        updated[index] = {
                          ...updated[index],
                          number_of_sessions: sessions,
                          total_price: Math.round(sessions * updated[index].price_per_session * 100) / 100,
                        };
                        setCyclusOptions(updated);
                      }}
                      title={t('form.numberOfSessions', 'Number of sessions')}
                    />
                    <Input
                      type="number"
                      min={1}
                      placeholder="#"
                      value={opt.number_of_weeks || ''}
                      onChange={(e) => {
                        const updated = [...cyclusOptions];
                        updated[index] = { ...updated[index], number_of_weeks: parseInt(e.target.value) || 0 };
                        setCyclusOptions(updated);
                      }}
                      title={t('form.numberOfWeeksColumn', 'Weeks')}
                    />
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">€</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="0.00"
                        value={opt.price_per_session || ''}
                        onChange={(e) => {
                          const updated = [...cyclusOptions];
                          const pps = parseFloat(e.target.value) || 0;
                          updated[index] = {
                            ...updated[index],
                            price_per_session: pps,
                            total_price: Math.round(updated[index].number_of_sessions * pps * 100) / 100,
                          };
                          setCyclusOptions(updated);
                        }}
                        className="pl-6"
                        title={t('form.pricePerSession')}
                      />
                    </div>
                    <div className="text-sm text-muted-foreground text-right whitespace-nowrap">
                      {formatCurrency(opt.total_price || 0)}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon" aria-label="Delete"
                      onClick={() => setCyclusOptions(cyclusOptions.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
                {cyclusOptions.length > 0 && (
                  <div className="grid grid-cols-[1fr_4rem_4rem_5rem_5rem_auto] items-center gap-2 text-xs text-muted-foreground">
                    <span>{t('form.cyclusOptionLabel', 'Label')}</span>
                    <span>{t('form.sessions', 'Lessen')}</span>
                    <span>{t('form.numberOfWeeksColumn', 'Weken')}</span>
                    <span>{t('form.pricePerSession', 'Per les')}</span>
                    <span className="text-right">{t('form.totalPrice', 'Totaal')}</span>
                    <span />
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCyclusOptions([...cyclusOptions, { label: '', number_of_sessions: 0, number_of_weeks: 0, price_per_session: 0, total_price: 0 }])}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('form.addCyclusOption', 'Add cyclus option')}
                </Button>
              </div>
            )}

            {/* Duration Options builder — for registrations only */}
            {isRegistration && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.durationOptions', 'Duration Options')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('form.durationOptionsHelp', 'How many weeks can a player choose? (e.g. 5, 10 or 15 weeks)')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {durationOptions.sort((a, b) => a - b).map((weeks) => (
                    <Badge
                      key={weeks}
                      variant="secondary"
                      className="flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer hover:bg-destructive/10"
                      onClick={() => setDurationOptions(durationOptions.filter(w => w !== weeks))}
                    >
                      {weeks} {t('form.numberOfWeeksColumn', 'weken')}
                      <Trash2 className="h-3 w-3 ml-1" />
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={52}
                    placeholder="#"
                    value={newDurationWeeks}
                    onChange={(e) => setNewDurationWeeks(parseInt(e.target.value) || '')}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">{t('form.numberOfWeeksColumn', 'weken')}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!newDurationWeeks || durationOptions.includes(Number(newDurationWeeks))}
                    onClick={() => {
                      if (newDurationWeeks && !durationOptions.includes(Number(newDurationWeeks))) {
                        setDurationOptions([...durationOptions, Number(newDurationWeeks)]);
                        setNewDurationWeeks('');
                      }
                    }}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t('form.addDurationOption', 'Add option')}
                  </Button>
                </div>
              </div>
            )}

            {/* Registration: when do players pay? */}
            {isRegistration && (
              <div className="space-y-3 rounded-lg border p-3">
                <Label className="text-sm font-medium">{t('form.registrationPayment', 'Payment')}</Label>
                <p className="text-xs text-muted-foreground">{t('form.registrationPaymentHelp', 'How should players pay when they register?')}</p>
                {([
                  { v: 'invoice_later', title: t('form.regPayInvoiceLater', 'Invoice later'), help: t('form.regPayInvoiceLaterHelp', 'You invoice players after you schedule them (default).') },
                  { v: 'online', title: t('form.regPayOnline', 'Charge online at sign-up'), help: t('form.regPayOnlineHelp', 'Players pay for their selected package immediately via the platform.') },
                  { v: 'both', title: t('form.regPayBoth', 'Let the player choose'), help: t('form.regPayBothHelp', 'Player picks: pay online now, or cash at the club.') },
                ] as const).map((opt) => (
                  <label key={opt.v} className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                    registrationChargeMode === opt.v && "border-primary bg-primary/5"
                  )}>
                    <input
                      type="radio"
                      name="reg_payment"
                      value={opt.v}
                      checked={registrationChargeMode === opt.v}
                      onChange={() => setRegistrationChargeMode(opt.v)}
                      className="mt-1"
                    />
                    <div className="space-y-0.5">
                      <span className="text-sm font-medium">{opt.title}</span>
                      <p className="text-xs text-muted-foreground">{opt.help}</p>
                    </div>
                  </label>
                ))}
              </div>
            )}

            {/* Event: Pricing + Payment Method */}
            {isEvent && (
              <div className="space-y-3 rounded-lg border p-3">
                <FormLabel className="text-sm font-medium">{t('form.pricing')}</FormLabel>
                <div className="grid grid-cols-2 gap-3">
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
                  <FormField
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">{t('form.currency', 'Currency')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="h-9">
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
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Max Participants */}
                <div>
                  <Label className="text-xs">{t('form.maxParticipants', 'Max Participants')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={maxParticipants}
                    onChange={(e) => setMaxParticipants(e.target.value ? Number(e.target.value) : '')}
                    placeholder={t('form.unlimited', 'Unlimited')}
                    className="mt-1"
                  />
                </div>

                {/* Payment Method */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">{t('form.paymentMethod', 'Payment Method')}</Label>
                  <p className="text-xs text-muted-foreground">{t('form.paymentMethodHelp', 'How should players pay for this event?')}</p>
                  
                  <label className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                    eventPaymentMethod === 'online' && "border-primary bg-primary/5"
                  )}>
                    <input
                      type="radio"
                      name="event_payment"
                      value="online"
                      checked={eventPaymentMethod === 'online'}
                      onChange={() => setEventPaymentMethod('online')}
                      className="mt-1"
                    />
                    <div className="space-y-0.5">
                      <span className="text-sm font-medium">{t('form.payOnline', 'Pay Online')}</span>
                      <p className="text-xs text-muted-foreground">{t('form.payOnlineHelp', 'Player pays via the platform when registering')}</p>
                    </div>
                  </label>
                  
                  <label className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                    eventPaymentMethod === 'cash' && "border-primary bg-primary/5"
                  )}>
                    <input
                      type="radio"
                      name="event_payment"
                      value="cash"
                      checked={eventPaymentMethod === 'cash'}
                      onChange={() => setEventPaymentMethod('cash')}
                      className="mt-1"
                    />
                    <div className="space-y-0.5">
                      <span className="text-sm font-medium">{t('form.payAtLocation', 'Pay at Location')}</span>
                      <p className="text-xs text-muted-foreground">{t('form.payAtLocationHelp', 'Player pays cash or pin on arrival')}</p>
                    </div>
                  </label>
                  
                  <label className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                    eventPaymentMethod === 'both' && "border-primary bg-primary/5"
                  )}>
                    <input
                      type="radio"
                      name="event_payment"
                      value="both"
                      checked={eventPaymentMethod === 'both'}
                      onChange={() => setEventPaymentMethod('both')}
                      className="mt-1"
                    />
                    <div className="space-y-0.5">
                      <span className="text-sm font-medium">{t('form.payBoth', 'Player Chooses')}</span>
                      <p className="text-xs text-muted-foreground">{t('form.payBothHelp', 'Player can choose to pay online or at the location')}</p>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {/* Pricing - only for cyclus */}
            {!isRegistration && !isEvent && (
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
               const weeks = form.watch('number_of_weeks') || 0;
                const perSessionTotal = extraCosts.filter(ec => (ec.type || 'per_session') === 'per_session').reduce((sum, ec) => sum + (ec.price || 0), 0);
                const oneTimeTotal = extraCosts.filter(ec => ec.type === 'one_time').reduce((sum, ec) => sum + (ec.price || 0), 0);
                const totalExtraCosts = Math.round((perSessionTotal * weeks + oneTimeTotal) * 100) / 100;
                const baseTotal = form.watch('total_price') || 0;
                const grandTotal = Math.round((Number(baseTotal) + totalExtraCosts) * 100) / 100;
                if (perSessionTotal <= 0 && oneTimeTotal <= 0) return null;
                return (
                  <div className="rounded-lg border bg-muted/50 p-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">{t('form.totalPrice')}</span>
                      <span>{formatCurrency(Number(baseTotal))}</span>
                    </div>
                    {perSessionTotal > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('form.extraCosts')} ({weeks}x {formatCurrency(perSessionTotal)})</span>
                        <span>{formatCurrency(Math.round(perSessionTotal * weeks * 100) / 100)}</span>
                      </div>
                    )}
                    {oneTimeTotal > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">{t('form.extraCosts')} ({t('form.oneTime', 'One-time')})</span>
                        <span>{formatCurrency(oneTimeTotal)}</span>
                      </div>
                    )}
                    <div className="border-t pt-1 flex justify-between font-semibold">
                      <span>{t('form.totalLabel')}</span>
                      <span>{formatCurrency(grandTotal)}</span>
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

              {/* Split payment toggle */}
              {!isRegistration && !isEvent && (
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium">{t('form.splitPayment', 'Split betaling over spelers')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('form.splitPaymentHelp', 'De totaalprijs (inclusief extra kosten) wordt gelijk verdeeld over alle ingeschreven spelers. Elke speler ontvangt een eigen factuur.')}
                    </p>
                  </div>
                  <Switch
                    checked={splitPayment}
                    onCheckedChange={setSplitPayment}
                  />
                </div>
              )}

              {/* Extra recurring costs */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.extraCosts')}</Label>
                <p className="text-xs text-muted-foreground">{t('form.extraCostsHelp')}</p>
                {extraCosts.map((cost, index) => (
                  <div key={index} className="space-y-1.5">
                    <div className="grid grid-cols-[1fr_6rem_5rem_auto] items-center gap-2">
                      <Input
                        placeholder={t('form.costDescription')}
                        value={cost.description}
                        onChange={(e) => {
                          const updated = [...extraCosts];
                          updated[index] = { ...updated[index], description: e.target.value };
                          setExtraCosts(updated);
                        }}
                      />
                      <div className="relative">
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
                      <div className="relative">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={cost.vat_rate ?? 21}
                          onChange={(e) => {
                            const updated = [...extraCosts];
                            updated[index] = { ...updated[index], vat_rate: Number(e.target.value) || 0 };
                            setExtraCosts(updated);
                          }}
                          className="pr-6"
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon" aria-label="Delete"
                        onClick={() => setExtraCosts(extraCosts.filter((_, i) => i !== index))}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="flex gap-2 pl-1">
                      <label className={cn(
                        "flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded-md border transition-colors",
                        (cost.type || 'per_session') === 'per_session' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                      )}>
                        <input
                          type="radio"
                          name={`cost_type_${index}`}
                          checked={(cost.type || 'per_session') === 'per_session'}
                          onChange={() => {
                            const updated = [...extraCosts];
                            updated[index] = { ...updated[index], type: 'per_session' };
                            setExtraCosts(updated);
                          }}
                          className="sr-only"
                        />
                        {t('form.perSession', 'Per session')}
                      </label>
                      <label className={cn(
                        "flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded-md border transition-colors",
                        cost.type === 'one_time' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                      )}>
                        <input
                          type="radio"
                          name={`cost_type_${index}`}
                          checked={cost.type === 'one_time'}
                          onChange={() => {
                            const updated = [...extraCosts];
                            updated[index] = { ...updated[index], type: 'one_time' };
                            setExtraCosts(updated);
                          }}
                          className="sr-only"
                        />
                        {t('form.oneTime', 'One-time')}
                      </label>
                    </div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setExtraCosts([...extraCosts, { description: '', price: 0, type: 'per_session', vat_rate: 21 }])}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t('form.addCost')}
                  </Button>
                  <ExtraCostPresetPicker
                    trainerId={ownerType === 'trainer' ? ownerId : undefined}
                    academyProfileId={ownerType === 'academy' ? ownerId : undefined}
                    onSelect={(cost) => setExtraCosts([...extraCosts, cost])}
                  />
                </div>
              </div>

              <FormDescription className="text-xs">
                {t('form.pricingHelp')}
              </FormDescription>
            </div>
            )}

            {!isEvent && (
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
                  {isRegistration && (
                    <div className="mt-3 space-y-2">
                      <Label className="text-sm text-muted-foreground">{t('form.customLessonTypes')}</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder={t('form.customLessonTypePlaceholder', { number: 1 })}
                          value={customLessonType1}
                          onChange={(e) => setCustomLessonType1(e.target.value)}
                          maxLength={30}
                        />
                        <Input
                          placeholder={t('form.customLessonTypePlaceholder', { number: 2 })}
                          value={customLessonType2}
                          onChange={(e) => setCustomLessonType2(e.target.value)}
                          maxLength={30}
                        />
                      </div>
                    </div>
                  )}
                </FormItem>
              )}
            />
            )}

            {/* Available Lesson Durations - for registrations */}
            {isRegistration && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('form.availableDurations', 'Lesson Durations')}</Label>
                <FormDescription className="text-xs">
                  {t('form.availableDurationsHelp', 'Which lesson durations can players choose from?')}
                </FormDescription>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {STANDARD_DURATIONS.map(d => (
                    <label key={d} className="flex items-center space-x-2">
                      <Checkbox
                        checked={availableDurations.includes(d)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setAvailableDurations(prev => [...prev, d]);
                          } else {
                            setAvailableDurations(prev => prev.filter(v => v !== d));
                          }
                        }}
                      />
                      <span className="text-sm">{d} min</span>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    type="number"
                    min={5}
                    max={300}
                    step={5}
                    placeholder={t('form.customDurationPlaceholder', 'e.g. 75')}
                    value={customDurationInput}
                    onChange={(e) => setCustomDurationInput(e.target.value ? Number(e.target.value) : '')}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">min</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!customDurationInput || availableDurations.includes(Number(customDurationInput))}
                    onClick={() => {
                      if (customDurationInput && !availableDurations.includes(Number(customDurationInput))) {
                        setAvailableDurations(prev => [...prev, Number(customDurationInput)]);
                        setCustomDurationInput('');
                      }
                    }}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    {t('form.addDuration', 'Add')}
                  </Button>
                </div>
                {availableDurations.filter(d => !(STANDARD_DURATIONS as readonly number[]).includes(d)).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {availableDurations.filter(d => !(STANDARD_DURATIONS as readonly number[]).includes(d)).sort((a, b) => a - b).map(d => (
                      <Badge key={d} variant="secondary" className="gap-1">
                        {d} min
                        <button
                          type="button"
                          className="ml-1 hover:text-destructive"
                          onClick={() => setAvailableDurations(prev => prev.filter(v => v !== d))}
                        >
                          ×
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}

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

            {!isEvent && (
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
            )}

            {isRegistration && (
              <FormField
                control={form.control}
                name="show_price_indication"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>{t('form.showPriceIndication')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('form.showPriceIndicationHelp')}
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


            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => onCancel?.()}
                disabled={isSubmitting}
              >
                {t('common:cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : isRegistration ? t('form.saveRegistration', 'Save Registration') : t('form.save')}
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
            </div>
          </form>
        </Form>
    </div>
  );
}
