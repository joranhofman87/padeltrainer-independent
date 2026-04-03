import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
const TIME_OPTIONS_START: string[] = [];
const TIME_OPTIONS_END: string[] = [];
for (let h = 6; h <= 23; h++) {
  TIME_OPTIONS_START.push(`${h.toString().padStart(2, '0')}:00`);
  TIME_OPTIONS_START.push(`${h.toString().padStart(2, '0')}:30`);
  TIME_OPTIONS_END.push(`${h.toString().padStart(2, '0')}:00`);
  TIME_OPTIONS_END.push(`${h.toString().padStart(2, '0')}:30`);
}
// 00:00 (midnight) is valid as end-of-day but not as start
TIME_OPTIONS_END.push('00:00');

export interface TrainerAvailabilityConfig {
  trainerId: string;
  trainerName: string;
  windows: { day: string; start: string; end: string }[];
  minRating: number | null;
  maxRating: number | null;
}

export type LinkStrategy = 'strict' | 'prefer' | 'ignore';

export interface GenerateProposalsConfig {
  startDate: string;
  trainerAvailability: TrainerAvailabilityConfig[];
  weights: ScoringWeights;
  additionalCriteria: string;
  linkStrategy: LinkStrategy;
  fillIncompleteGroups: boolean;
  maxGroupSize: number;
}

interface TrainerOption {
  id: string;
  name: string;
  preferredMinRating: number | null;
  preferredMaxRating: number | null;
}

interface GenerateProposalsWizardProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  cycle: Cycle;
  onGenerate: (config: GenerateProposalsConfig) => Promise<void>;
  isGenerating?: boolean;
  /** Owner type for fetching trainers */
  ownerType: 'trainer' | 'academy';
  ownerId: string;
  /** When true, renders inline in a Card instead of a Dialog */
  inline?: boolean;
}

export function GenerateProposalsWizard({
  open,
  onOpenChange,
  cycle,
  onGenerate,
  isGenerating = false,
  ownerType,
  ownerId,
  inline = false,
}: GenerateProposalsWizardProps) {
  const { t } = useTranslation('cycles');
  const STORAGE_KEY = `generate-proposals-draft-${cycle.id}`;
  const restoredRef = useRef(false);
  const totalSteps = 3;

  // Try to restore from localStorage
  const getSavedDraft = useCallback(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {}
    return null;
  }, [STORAGE_KEY]);

  const draft = restoredRef.current ? null : getSavedDraft();

  const [step, setStep] = useState(draft?.step || 1);

  // Step 1: Schedule
  const [startDate, setStartDate] = useState<Date>(
    draft?.startDate ? new Date(draft.startDate) : new Date(cycle.start_date)
  );
  const [availableTrainers, setAvailableTrainers] = useState<TrainerOption[]>([]);
  const [trainerConfigs, setTrainerConfigs] = useState<TrainerAvailabilityConfig[]>(
    draft?.trainerConfigs || []
  );

  // Step 2: Weights
  const [weights, setWeights] = useState<ScoringWeights>(
    draft?.weights || cycle.settings?.scoring_weights || DEFAULT_SCORING_WEIGHTS
  );

  // Step 3: Additional criteria
  const [additionalCriteria, setAdditionalCriteria] = useState(draft?.additionalCriteria || '');
  const [linkStrategy, setLinkStrategy] = useState<LinkStrategy>(draft?.linkStrategy || 'prefer');
  const [fillIncompleteGroups, setFillIncompleteGroups] = useState(draft?.fillIncompleteGroups ?? true);
  const [maxGroupSize, setMaxGroupSize] = useState<number>(draft?.maxGroupSize ?? cycle.settings?.max_group_size ?? 4);

  // Show toast if draft was restored
  useEffect(() => {
    if (!restoredRef.current && draft) {
      restoredRef.current = true;
      toast.info(t('proposals.wizard.draftRestored', { defaultValue: 'Your previous configuration was restored' }));
    } else {
      restoredRef.current = true;
    }
  }, []);

  // Persist state to localStorage on every change
  useEffect(() => {
    const data = {
      step,
      startDate: startDate.toISOString(),
      trainerConfigs,
      weights,
      additionalCriteria,
      linkStrategy,
      fillIncompleteGroups,
      maxGroupSize,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }, [step, startDate, trainerConfigs, weights, additionalCriteria, linkStrategy, fillIncompleteGroups, maxGroupSize, STORAGE_KEY]);

  // Load trainers
  useEffect(() => {
    if (!inline && !open) return;
    loadTrainers();
  }, [open, ownerType, ownerId]);

  const loadTrainers = async () => {
    let trainers: TrainerOption[] = [];

    if (ownerType === 'academy') {
      const { data: atData } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', ownerId)
        .eq('status', 'active');

      const trainerProfileIds = (atData || []).map(at => at.trainer_profile_id);

      if (trainerProfileIds.length > 0) {
        const { data: tpData } = await supabase
          .from('trainer_profiles')
          .select('id, user_id, preferred_min_rating, preferred_max_rating')
          .in('id', trainerProfileIds);

        const userIds = (tpData || []).map(tp => tp.user_id).filter(Boolean);
        const { data: profilesData } = userIds.length > 0
          ? await supabase.from('profiles').select('user_id, full_name').in('user_id', userIds)
          : { data: [] };

        const nameMap = new Map((profilesData || []).map(p => [p.user_id, p.full_name]));

        trainers = (tpData || []).map(tp => ({
          id: tp.id,
          name: nameMap.get(tp.user_id) || 'Unknown',
          preferredMinRating: tp.preferred_min_rating ?? null,
          preferredMaxRating: tp.preferred_max_rating ?? null,
        }));
      }
    } else {
      const { data } = await supabase
        .from('trainer_profiles')
        .select('id, user_id, preferred_min_rating, preferred_max_rating')
        .eq('id', ownerId)
        .single();

      if (data) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('user_id', data.user_id)
          .single();

        trainers = [{
          id: data.id,
          name: profileData?.full_name || 'Unknown',
          preferredMinRating: data.preferred_min_rating,
          preferredMaxRating: data.preferred_max_rating,
        }];
      }
    }

    setAvailableTrainers(trainers);

    // Only pre-select if we don't have a restored draft with trainer configs
    if (trainerConfigs.length === 0) {
      const applicableIds = cycle.settings?.applicable_trainer_ids || [];
      const preSelected = applicableIds.length > 0
        ? trainers.filter(t => applicableIds.includes(t.id))
        : [];

      setTrainerConfigs(preSelected.map(t => ({
        trainerId: t.id,
        trainerName: t.name,
        windows: [{ day: 'monday', start: '09:00', end: '17:00' }],
        minRating: t.preferredMinRating,
        maxRating: t.preferredMaxRating,
      })));
    }
  };

  const toggleTrainer = (trainer: TrainerOption) => {
    setTrainerConfigs(prev => {
      const exists = prev.find(c => c.trainerId === trainer.id);
      if (exists) return prev.filter(c => c.trainerId !== trainer.id);
      return [...prev, {
        trainerId: trainer.id,
        trainerName: trainer.name,
        windows: [{ day: 'monday', start: '09:00', end: '17:00' }],
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
      linkStrategy,
      fillIncompleteGroups,
      maxGroupSize,
    });
    
  };

  const canProceedStep1 = trainerConfigs.length > 0 && trainerConfigs.some(c => c.windows.length > 0);

  const subStepLabels = [
    t('proposals.wizard.step1Label', { defaultValue: 'Schedule & Trainers' }),
    t('proposals.wizard.step2Label', { defaultValue: 'Scoring Weights' }),
    t('proposals.wizard.step3Label', { defaultValue: 'Additional Criteria' }),
  ];

  const stepContent = (
    <>
      {/* Sub-step indicators */}
      {inline && (
        <div className="flex items-center gap-2 mb-6">
          {subStepLabels.map((label, idx) => {
            const stepNum = idx + 1;
            const isActive = step === stepNum;
            const isCompleted = step > stepNum;
            return (
              <button
                key={idx}
                onClick={() => {
                  if (isCompleted || isActive) setStep(stepNum);
                }}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                  isActive && 'bg-primary text-primary-foreground',
                  isCompleted && 'bg-primary/10 text-primary cursor-pointer',
                  !isActive && !isCompleted && 'bg-muted text-muted-foreground'
                )}
                disabled={!isCompleted && !isActive}
              >
                <span className={cn(
                  'flex items-center justify-center h-5 w-5 rounded-full text-xs font-bold',
                  isActive && 'bg-primary-foreground text-primary',
                  isCompleted && 'bg-primary text-primary-foreground',
                  !isActive && !isCompleted && 'bg-muted-foreground/30 text-muted-foreground'
                )}>
                  {stepNum}
                </span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
      )}

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
                  <div key={idx} className="flex flex-col sm:flex-row gap-2">
                    <Select
                      value={window.day}
                      onValueChange={(v) => updateWindow(config.trainerId, idx, 'day', v)}
                    >
                      <SelectTrigger className="w-full sm:w-[120px]">
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
                    <div className="flex items-center gap-2">
                      <Select
                        value={window.start}
                        onValueChange={(v) => updateWindow(config.trainerId, idx, 'start', v)}
                      >
                        <SelectTrigger className="flex-1 sm:w-[90px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIME_OPTIONS_START.map(t => (
                            <SelectItem key={t} value={t}>{t}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">–</span>
                      <Select
                        value={window.end}
                        onValueChange={(v) => updateWindow(config.trainerId, idx, 'end', v)}
                      >
                        <SelectTrigger className="flex-1 sm:w-[90px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TIME_OPTIONS_END.map(t => (
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
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs self-start"
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
          {/* Max group size */}
          <div className="space-y-2">
            <Label>{t('proposals.wizard.maxGroupSize', { defaultValue: 'Max players per group' })}</Label>
            <p className="text-sm text-muted-foreground">
              {t('proposals.wizard.maxGroupSizeHelp', { defaultValue: 'Maximum number of players that can be assigned to a single time slot.' })}
            </p>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxGroupSize}
              onChange={(e) => setMaxGroupSize(Math.max(1, parseInt(e.target.value) || 4))}
              className="w-24"
            />
          </div>

          <Separator />

          {/* Linked players strategy */}
          <div className="space-y-2">
            <Label>{t('proposals.wizard.linkStrategy', { defaultValue: 'Linked players' })}</Label>
            <p className="text-sm text-muted-foreground">
              {t('proposals.wizard.linkStrategyHelp', { defaultValue: 'How should players who want to train together be handled?' })}
            </p>
            <Select value={linkStrategy} onValueChange={(v) => setLinkStrategy(v as LinkStrategy)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strict">
                  {t('proposals.wizard.linkStrict', { defaultValue: 'Always keep together' })}
                </SelectItem>
                <SelectItem value="prefer">
                  {t('proposals.wizard.linkPrefer', { defaultValue: 'Try to keep together (recommended)' })}
                </SelectItem>
                <SelectItem value="ignore">
                  {t('proposals.wizard.linkIgnore', { defaultValue: 'Ignore links' })}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {linkStrategy === 'strict' && t('proposals.wizard.linkStrictHelp', { defaultValue: 'Linked players are placed as a unit. If no slot fits the group, they are skipped.' })}
              {linkStrategy === 'prefer' && t('proposals.wizard.linkPreferHelp', { defaultValue: 'Strong preference to keep linked players together, but they can be split if needed.' })}
              {linkStrategy === 'ignore' && t('proposals.wizard.linkIgnoreHelp', { defaultValue: 'All players are treated individually. Links are not considered.' })}
            </p>
          </div>

          {linkStrategy !== 'ignore' && (
            <>
              <Separator />
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="font-medium">
                    {t('proposals.wizard.fillIncompleteGroups', { defaultValue: 'Fill incomplete groups' })}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {fillIncompleteGroups
                      ? t('proposals.wizard.fillIncompleteGroupsOnHelp', { defaultValue: 'Remaining spots are filled with other compatible players.' })
                      : t('proposals.wizard.fillIncompleteGroupsOffHelp', { defaultValue: 'Spots are left empty — the group trains alone or finds someone themselves.' })
                    }
                  </p>
                </div>
                <Switch
                  checked={fillIncompleteGroups}
                  onCheckedChange={setFillIncompleteGroups}
                />
              </div>
            </>
          )}

          <Separator />

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
    </>
  );

  const footerContent = (
    <div className={cn("flex justify-between", inline ? "mt-6 pt-4 border-t" : "flex-row sm:justify-between")}>
      <div>
        {step > 1 && (
          <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={isGenerating}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            {t('common:back', 'Back')}
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        {!inline && (
          <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={isGenerating}>
            {t('common:cancel', 'Cancel')}
          </Button>
        )}
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
    </div>
  );

  // Inline mode: render as Card
  if (inline) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {t('proposals.generateAll')}
          </CardTitle>
          <CardDescription>
            {t('proposals.wizard.stepLabel', { step, total: totalSteps, defaultValue: `Step ${step} of ${totalSteps}` })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {stepContent}
          {footerContent}
        </CardContent>
      </Card>
    );
  }

  // Dialog mode (default)
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
        {stepContent}
        <DialogFooter className="flex-row justify-between sm:justify-between">
          {footerContent}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
