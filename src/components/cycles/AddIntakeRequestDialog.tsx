import { useState, useEffect, useRef } from 'react';
import {
  clearCreationAttempt,
  creationRequestIdFor,
  type CreationAttempt,
} from '@/lib/creationRequestId';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { buildGuestPlayerDbFields } from '@/lib/profileName';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { createOptionalPhoneSchema } from '@/lib/validation';
import { createManualIntakeRequest, type Cycle, type TimeWindow } from '@/lib/cycles';
import DayAvailabilityPicker, { type DayAvailability } from './DayAvailabilityPicker';

interface AddIntakeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cycleId?: string;
  cycles: Cycle[];
  onSuccess: () => void;
}

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
  /**
   * The create attempt currently in flight, KEYED on the identity fields the server fingerprints.
   * A raw id held across every failure was wrong in one direction: correcting a typo in the name or
   * the address and saving again reused the old id, and the command answers a changed payload with
   * PLAYER_CREATE_IDEMPOTENCY_CONFLICT — so the correction could not be saved at all.
   */
  const creationAttemptRef = useRef<CreationAttempt>(null);
  const [ratingSystems, setRatingSystems] = useState<Array<{
    code: string;
    name: string;
    min_rating: number;
    max_rating: number;
    step: number;
  }>>([]);
  const [trainers, setTrainers] = useState<Array<{ id: string; name: string }>>([]);
  const [dayAvailability, setDayAvailability] = useState<DayAvailability>({});

  // Built inside the component (mirroring CycleApplicationForm) so the phone
  // validation message can be translated via t().
  const formSchema = z.object({
    cycle_id: z.string().min(1, 'Please select a cycle'),
    first_name: z.string().trim().min(1, 'First name is required').max(50),
    last_name: z.string().trim().max(50).optional().default(''),
    // OPTIONAL. Children, walk-ins and people who decline to give an address are real players, and
    // requiring one here is what pushed staff into typing placeholder addresses that then look, to
    // every matcher downstream, like a shared household email (U2, owner 2026-08-09).
    email: z.union([z.literal(''), z.string().trim().email('Invalid email').max(255)])
      .optional()
      .default(''),
    phone: createOptionalPhoneSchema(t('application.form.validation.phoneInvalid')),
    rating_system: z.string().default('knltb'),
    rating: z.coerce.number().optional(),
    lesson_types: z.array(z.string()).min(1, 'Select at least one lesson type'),
    preferred_duration_minutes: z.coerce.number().default(60),
    sessions_per_week: z.coerce.number().min(1).max(7).default(1),
    preferred_trainer_id: z.string().optional(),
    notes: z.string().optional(),
  });

  type FormData = z.infer<typeof formSchema>;

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      cycle_id: cycleId || '',
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      rating_system: 'knltb',
      rating: undefined,
      lesson_types: ['group'],
      preferred_duration_minutes: 60,
      sessions_per_week: 1,
      preferred_trainer_id: 'none',
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

  // Fetch trainers when cycle changes
  const selectedCycleId = form.watch('cycle_id');
  useEffect(() => {
    const fetchTrainers = async () => {
      try {
        const cycleToUse = selectedCycleId || cycleId;
        if (!cycleToUse) {
          setTrainers([]);
          return;
        }

        const cycle = cycles.find((c) => c.id === cycleToUse);
        if (!cycle) {
          setTrainers([]);
          return;
        }

        // Helper: given trainer profile rows [{id, user_id}], fetch names from profiles
        const resolveTrainerNames = async (trainerProfiles: Array<{ id: string; user_id: string }>) => {
          if (!trainerProfiles.length) return [];
          const userIds = trainerProfiles.map((tp) => tp.user_id);
          const { data: profiles } = await supabase
            .from('profiles')
            .select('user_id, full_name')
            .in('user_id', userIds);
          return trainerProfiles
            .map((tp) => ({
              id: tp.id,
              name: profiles?.find((p) => p.user_id === tp.user_id)?.full_name || 'Unknown',
            }))
            .filter((t) => t.name !== 'Unknown');
        };

        if (cycle.owner_type === 'club') {
          const { data: clubData } = await supabase
            .from('club_profiles')
            .select('location_id')
            .eq('id', cycle.owner_id)
            .single();

          if (clubData?.location_id) {
            const { data: trainerLocations } = await supabase
              .from('trainer_locations')
              .select('trainer_id')
              .eq('location_id', clubData.location_id)
              .in('relationship_type', ['club', 'club_trainer']);

            if (trainerLocations && trainerLocations.length > 0) {
              const trainerIds = trainerLocations.map((tl) => tl.trainer_id);
              const { data: trainerProfiles } = await supabase
                .from('trainer_profiles')
                .select('id, user_id')
                .in('id', trainerIds);

              setTrainers(await resolveTrainerNames(trainerProfiles || []));
            }
          }
        } else if (cycle.owner_type === 'trainer') {
          const { data: trainerData } = await supabase
            .from('trainer_profiles')
            .select('id, user_id')
            .eq('id', cycle.owner_id)
            .single();

          if (trainerData) {
            setTrainers(await resolveTrainerNames([trainerData]));
          }
        } else if (cycle.owner_type === 'academy') {
          // Fetch trainers linked to this academy
          const { data: academyTrainers } = await supabase
            .from('academy_trainers')
            .select('trainer_profile_id')
            .eq('academy_profile_id', cycle.owner_id)
            .eq('status', 'active');

          if (academyTrainers && academyTrainers.length > 0) {
            const trainerIds = academyTrainers.map((at) => at.trainer_profile_id);
            const { data: trainerProfiles } = await supabase
              .from('trainer_profiles')
              .select('id, user_id')
              .in('id', trainerIds);

            setTrainers(await resolveTrainerNames(trainerProfiles || []));
          }
        }
      } catch (error) {
        logger.error('Error fetching trainers', error as Error, { component: 'AddIntakeRequestDialog' });
        setTrainers([]);
      }
    };

    fetchTrainers();
  }, [selectedCycleId, cycleId, cycles]);

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
    const nameForCreate = buildGuestPlayerDbFields(data.first_name, data.last_name).full_name;
    // One id for this create ATTEMPT, reused by every retry of it — a double submit, a network
    // retry, a second click — and minted afresh the moment the operator changes who they are
    // adding, because that is a different attempt.
    const creationRequestId = creationRequestIdFor(
      creationAttemptRef,
      JSON.stringify([data.cycle_id, nameForCreate, data.email.trim().toLowerCase(), (data.phone ?? '').trim()]),
    );
    try {
      // Step 1: Create or find the player account
      const { data: playerData, error: playerError } = await supabase.functions.invoke(
        'create-manual-player',
        {
          body: {
            email: data.email,
            firstName: data.first_name,
            lastName: data.last_name,
            fullName: buildGuestPlayerDbFields(data.first_name, data.last_name).full_name,
            phone: data.phone,
            ratingSystem: data.rating_system,
            rating: data.rating,
            cycleName: cycles.find(c => c.id === data.cycle_id)?.name || '',
            creationRequestId,
            // The owner the cycle already names. Without it the player is created ownerless — it
            // never appears in the academy's players list, and it misses the scoped, idempotent
            // create path entirely (U2).
            ...(() => {
              const c = cycles.find((x) => x.id === data.cycle_id);
              if (c?.owner_type === 'academy') return { academyProfileId: c.owner_id };
              if (c?.owner_type === 'trainer') return { trainerProfileId: c.owner_id };
              return {};
            })(),
          },
        }
      );

      if (playerError) {
        throw new Error(playerError.message || 'Failed to create player account');
      }

      if (playerData?.error) {
        throw new Error(playerData.error);
      }

      // Step 2: the intake request carries the Player the command answered with — by CANONICAL id.
      // It is no longer possible for this step to be handed a profile the previous one guessed from
      // an address, because that guess no longer happens anywhere; and it is no longer possible for
      // a legacy guest id to pass through here, because the endpoint stopped returning one (U2,
      // owner correction 2026-08-09) — the server command derives the legacy columns itself.
      if (!playerData?.personId) {
        throw new Error('player_create_no_person');
      }
      const preferredDays = [...new Set(timeWindows.map((tw) => tw.day!))];

      await createManualIntakeRequest({
        cycle_id: data.cycle_id,
        person_id: playerData.personId,
        full_name: buildGuestPlayerDbFields(data.first_name, data.last_name).full_name,
        email: data.email,
        phone: data.phone || undefined,
        rating_system: data.rating_system,
        rating: data.rating,
        lesson_types: data.lesson_types,
        preferred_days: preferredDays,
        preferred_time_windows: timeWindows,
        preferred_duration_minutes: data.preferred_duration_minutes,
        sessions_per_week: data.sessions_per_week,
        preferred_trainer_ids: data.preferred_trainer_id === 'none' ? [] : (data.preferred_trainer_id ? [data.preferred_trainer_id] : []),
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
      // the attempt is finished: the next player is a NEW attempt with a new id
      clearCreationAttempt(creationAttemptRef);
      onSuccess();
    } catch (error: any) {
      logger.error('Error creating intake request', error as Error, { component: 'AddIntakeRequestDialog' });
      // The intake-target trigger (migration 20260808100000) rejects a sign-up on a training cyclus /
      // rebook round — give staff a clear reason instead of a raw check_violation.
      if (/registration or event cycle/i.test(String(error?.message ?? error))) {
        toast.error(t('intake.notARegistration', 'Je kunt alleen aanmeldingen toevoegen aan een inschrijving of evenement — niet aan een trainingscyclus.'));
      } else {
        toast.error(getFriendlyErrorMessage(error, 'Failed to add registration'));
      }
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

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            {t('intakeRequests.profileCreationNote')}
          </AlertDescription>
        </Alert>

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
                            {cycle.name}{cycle.location?.name ? ` — ${cycle.location.name}` : ''}
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

              <div className="grid gap-4 sm:grid-cols-2">
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
                        <Input type="tel" inputMode="tel" {...field} />
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
                    <FormLabel>{t('application.form.ratingLabel')}</FormLabel>
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
                  name="lesson_types"
                  render={() => {
                    const selectedCycle = cycles.find(c => c.id === selectedCycleId || c.id === cycleId);
                    const standardTypes = ['private', 'duo', 'group', 'group3', 'group4', 'kids'] as const;
                    const customTypes = (selectedCycle?.settings?.custom_lesson_types as string[] | undefined) || [];
                    const allTypes: string[] = [...standardTypes, ...customTypes];
                    
                    return (
                    <FormItem>
                      <FormLabel>{t('application.form.lessonType')}</FormLabel>
                      <div className="grid grid-cols-2 gap-2">
                        {allTypes.map(type => (
                          <FormField
                            key={type}
                            control={form.control}
                            name="lesson_types"
                            render={({ field }) => (
                              <FormItem 
                                className="flex items-center space-x-2 space-y-0 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
                                onClick={(e) => {
                                  if ((e.target as HTMLElement).closest('button[role="checkbox"]')) return;
                                  const current = field.value || [];
                                  const updated = current.includes(type)
                                    ? current.filter((v: string) => v !== type)
                                    : [...current, type];
                                  field.onChange(updated);
                                }}
                              >
                                <FormControl>
                                  <Checkbox
                                    checked={field.value?.includes(type)}
                                    onCheckedChange={(checked) => {
                                      const current = field.value || [];
                                      const updated = checked
                                        ? [...current, type]
                                        : current.filter((v: string) => v !== type);
                                      field.onChange(updated);
                                    }}
                                  />
                                </FormControl>
                                <FormLabel className="font-normal cursor-pointer flex-1 m-0">
                                  {(standardTypes as readonly string[]).includes(type)
                                    ? t(`application.form.lessonTypes.${type}`)
                                    : type.charAt(0).toUpperCase() + type.slice(1)}
                                </FormLabel>
                              </FormItem>
                            )}
                          />
                        ))}
                      </div>
                      <FormMessage />
                    </FormItem>
                    );
                  }}
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

            <FormField
              control={form.control}
              name="sessions_per_week"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.sessionsPerWeek')}</FormLabel>
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
              name="preferred_trainer_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('application.form.preferredTrainer')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || 'none'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('application.form.noPreference')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">{t('application.form.noPreference')}</SelectItem>
                      {trainers.map((trainer) => (
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
              </div>
            </div>

            {/* Availability */}
            <div className="space-y-4">
              <h3 className="font-medium">{t('application.form.availabilityLabel')}</h3>
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
