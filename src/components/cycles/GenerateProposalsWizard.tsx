import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { type Cycle, type ScoringWeights, DEFAULT_SCORING_WEIGHTS } from '@/lib/cycles';
import { ScoringWeightsPanel } from './ScoringWeightsPanel';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME_OPTIONS: string[] = [];
for (let h = 6; h <= 22; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 22 && m > 0) break;
    TIME_OPTIONS.push(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`);
  }
}

export interface TrainerAvailabilityConfig {
  trainerId: string;
  trainerName: string;
  windows: { day: string; start: string; end: string }[];
  minRating: number | null;
  maxRating: number | null;
}

export interface GenerateProposalsConfig {
  startDate: string;
  trainerAvailability: TrainerAvailabilityConfig[];
  weights: ScoringWeights;
  additionalCriteria: string;
}

interface TrainerOption {
  id: string;
  name: string;
  preferredMinRating: number | null;
  preferredMaxRating: number | null;
}

interface GenerateProposalsWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cycle: Cycle;
  onGenerate: (config: GenerateProposalsConfig) => Promise<void>;
  isGenerating?: boolean;
  /** Owner type for fetching trainers */
  ownerType: 'trainer' | 'academy';
  ownerId: string;
}

export function GenerateProposalsWizard({
  open,
  onOpenChange,
  cycle,
  onGenerate,
  isGenerating = false,
  ownerType,
  ownerId,
}: GenerateProposalsWizardProps) {
  const { t } = useTranslation('cycles');
  const [step, setStep] = useState(1);
  const totalSteps = 3;

  // Step 1: Schedule
  const [startDate, setStartDate] = useState<Date>(new Date(cycle.start_date));
  const [availableTrainers, setAvailableTrainers] = useState<TrainerOption[]>([]);
  const [trainerConfigs, setTrainerConfigs] = useState<TrainerAvailabilityConfig[]>([]);

  // Step 2: Weights
  const [weights, setWeights] = useState<ScoringWeights>(
    cycle.settings?.scoring_weights || DEFAULT_SCORING_WEIGHTS
  );

  // Step 3: Additional criteria
  const [additionalCriteria, setAdditionalCriteria] = useState('');

  // Load trainers
  useEffect(() => {
    if (!open) return;
    loadTrainers();
  }, [open, ownerType, ownerId]);

  const loadTrainers = async () => {
    let trainers: TrainerOption[] = [];

    if (ownerType === 'academy') {
      // First get academy trainer links
      const { data: atData, error: atError } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', ownerId)
        .eq('status', 'active');

      if (atError) {
        console.error('Error fetching academy trainers:', atError);
      }

      const trainerProfileIds = (atData || []).map(at => at.trainer_profile_id);

      if (trainerProfileIds.length > 0) {
        const { data: tpData, error: tpError } = await supabase
          .from('trainer_profiles')
          .select('id, preferred_min_rating, preferred_max_rating, profiles:user_id (full_name)')
          .in('id', trainerProfileIds);

        if (tpError) {
          console.error('Error fetching trainer profiles:', tpError);
        }

        trainers = (tpData || []).map((tp: any) => {
          const profile = Array.isArray(tp.profiles) ? tp.profiles[0] : tp.profiles;
          return {
            id: tp.id,
            name: profile?.full_name || 'Unknown',
            preferredMinRating: tp.preferred_min_rating ?? null,
            preferredMaxRating: tp.preferred_max_rating ?? null,
          };
        });
      }
    } else {
      // Trainer owner — just the trainer themselves
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id, preferred_min_rating, preferred_max_rating, profiles:user_id (full_name)')
        .eq('id', ownerId)
        .single();

      if (data) {
        const profile = Array.isArray((data as any).profiles) ? (data as any).profiles[0] : (data as any).profiles;
        trainers = [{
          id: data.id,
          name: profile?.full_name || 'Unknown',
          preferredMinRating: data.preferred_min_rating,
          preferredMaxRating: data.preferred_max_rating,
        }];
      }
    }

    setAvailableTrainers(trainers);

    // Pre-select trainers from cycle settings
    const applicableIds = cycle.settings?.applicable_trainer_ids || [];
    const preSelected = applicableIds.length > 0
      ? trainers.filter(t => applicableIds.includes(t.id))
      : trainers;

    setTrainerConfigs(preSelected.map(t => ({
      trainerId: t.id,
      trainerName: t.name,
      windows: [],
      minRating: t.preferredMinRating,
      maxRating: t.preferredMaxRating,
    })));
  };

  const toggleTrainer = (trainer: TrainerOption) => {
    setTrainerConfigs(prev => {
      const exists = prev.find(c => c.trainerId === trainer.id);
      if (exists) return prev.filter(c => c.trainerId !== trainer.id);
      return [...prev, {
        trainerId: trainer.id,
        trainerName: trainer.name,
        windows: [],
        minRating: trainer.preferredMinRating,
        maxRating: trainer.preferredMaxRating,
      }];
    });
  };

  const addWindow = (trainerId: string) => {
    setTrainerConfigs(prev =>
      prev.map(c =>
        c.trainerId === trainerId
          ? { ...c, windows: [...c.windows, { day: 'monday', start: '09:00', end: '17:00' }] }
          : c
      )
    );
  };

  const updateWindow = (trainerId: string, index: number, field: string, value: string) => {
    setTrainerConfigs(prev =>
      prev.map(c =>
        c.trainerId === trainerId
          ? {
              ...c,
              windows: c.windows.map((w, i) =>
                i === index ? { ...w, [field]: value } : w
              ),
            }
          : c
      )
    );
  };

  const removeWindow = (trainerId: string, index: number) => {
    setTrainerConfigs(prev =>
      prev.map(c =>
        c.trainerId === trainerId
          ? { ...c, windows: c.windows.filter((_, i) => i !== index) }
          : c
      )
    );
  };

  const updateTrainerRating = (trainerId: string, field: 'minRating' | 'maxRating', value: string) => {
    setTrainerConfigs(prev =>
      prev.map(c =>
        c.trainerId === trainerId
          ? { ...c, [field]: value ? parseFloat(value) : null }
          : c
      )
    );
  };

  const handleGenerate = async () => {
    await onGenerate({
      startDate: format(startDate, 'yyyy-MM-dd'),
      trainerAvailability: trainerConfigs,
      weights,
      additionalCriteria,
    });
  };

  const canProceedStep1 = trainerConfigs.length > 0 && trainerConfigs.some(c => c.windows.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {t('proposals.generateAll')}
          </DialogTitle>
          <DialogDescription>
            {t('proposals.wizard.stepLabel', { step, total: totalSteps, defaultValue: `Step ${step} of ${totalSteps}` })}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Schedule & Trainers */}
        {step === 1 && (
          <div className="space-y-6 py-2">
            {/* Start date */}
            <div className="space-y-2">
              <Label>{t('proposals.wizard.startDate', { defaultValue: 'Start date' })}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(startDate, 'PPP')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={(d) => d && setStartDate(d)}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <Separator />

            {/* Trainer selection */}
            <div className="space-y-3">
              <Label>{t('proposals.wizard.selectTrainers', { defaultValue: 'Select trainers' })}</Label>
              <div className="flex flex-wrap gap-2">
                {availableTrainers.map(trainer => {
                  const isSelected = trainerConfigs.some(c => c.trainerId === trainer.id);
                  return (
                    <Badge
                      key={trainer.id}
                      variant={isSelected ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => toggleTrainer(trainer)}
                    >
                      {trainer.name}
                    </Badge>
                  );
                })}
              </div>
            </div>

            {/* Per-trainer availability */}
            {trainerConfigs.map(config => (
              <div key={config.trainerId} className="space-y-3 p-3 border rounded-lg">
                <div className="flex items-center justify-between">
                  <Label className="font-semibold">{config.trainerName}</Label>
                </div>

                {/* Level range */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      {t('proposals.wizard.minRating', { defaultValue: 'Min rating' })}
                    </Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={config.minRating ?? ''}
                      onChange={(e) => updateTrainerRating(config.trainerId, 'minRating', e.target.value)}
                      placeholder="Any"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      {t('proposals.wizard.maxRating', { defaultValue: 'Max rating' })}
                    </Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={config.maxRating ?? ''}
                      onChange={(e) => updateTrainerRating(config.trainerId, 'maxRating', e.target.value)}
                      placeholder="Any"
                    />
                  </div>
                </div>

                {/* Time windows */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    {t('proposals.wizard.availableWindows', { defaultValue: 'Available time windows' })}
                  </Label>
                  {config.windows.map((window, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Select
                        value={window.day}
                        onValueChange={(v) => updateWindow(config.trainerId, idx, 'day', v)}
                      >
                        <SelectTrigger className="w-[120px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAYS.map(d => (
                            <SelectItem key={d} value={d}>
                              {d.charAt(0).toUpperCase() + d.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={window.start}
                        onValueChange={(v) => updateWindow(config.trainerId, idx, 'start', v)}
                      >
                        <SelectTrigger className="w-[90px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIME_OPTIONS.map(t => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">–</span>
                      <Select
                        value={window.end}
                        onValueChange={(v) => updateWindow(config.trainerId, idx, 'end', v)}
                      >
                        <SelectTrigger className="w-[90px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIME_OPTIONS.map(t => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => removeWindow(config.trainerId, idx)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => addWindow(config.trainerId)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    {t('proposals.wizard.addWindow', { defaultValue: 'Add time window' })}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Step 2: Scoring Weights */}
        {step === 2 && (
          <ScoringWeightsPanel
            weights={weights}
            onWeightsChange={setWeights}
          />
        )}

        {/* Step 3: Additional Criteria */}
        {step === 3 && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('proposals.wizard.additionalCriteria', { defaultValue: 'Additional criteria' })}</Label>
              <p className="text-sm text-muted-foreground">
                {t('proposals.wizard.additionalCriteriaHelp', { defaultValue: 'Enter any extra rules in plain text. AI will interpret and apply them when generating proposals.' })}
              </p>
              <Textarea
                value={additionalCriteria}
                onChange={(e) => setAdditionalCriteria(e.target.value)}
                placeholder="e.g. Kids lessons only during the day, in the evening always 4 players required"
                rows={4}
              />
            </div>
          </div>
        )}

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div>
            {step > 1 && (
              <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={isGenerating}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                {t('common:back', 'Back')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isGenerating}>
              {t('common:cancel', 'Cancel')}
            </Button>
            {step < totalSteps ? (
              <Button
                onClick={() => setStep(s => s + 1)}
                disabled={step === 1 && !canProceedStep1}
              >
                {t('common:next', 'Next')}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <Button onClick={handleGenerate} disabled={isGenerating}>
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('proposals.generating')}
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    {t('proposals.weights.generate')}
                  </>
                )}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
