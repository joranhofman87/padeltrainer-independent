import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Info, Zap, Clock, Users, TrendingUp, LayoutGrid, CalendarDays, Gauge } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getRatingSystems, type RatingSystemConfig } from "@/lib/ratingSystems";

export interface ScoringWeights {
  time_match: number;
  preferred_trainer: number;
  level_compatible: number;
  priority_bonus: number;
  capacity_available: number;
  sessions_per_week: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  time_match: 35,
  preferred_trainer: 20,
  level_compatible: 15,
  priority_bonus: 10,
  capacity_available: 10,
  sessions_per_week: 10,
};

const PRESETS: Record<string, ScoringWeights> = {
  balanced: {
    time_match: 35,
    preferred_trainer: 20,
    level_compatible: 15,
    priority_bonus: 10,
    capacity_available: 10,
    sessions_per_week: 10,
  },
  timeFocused: {
    time_match: 50,
    preferred_trainer: 10,
    level_compatible: 15,
    priority_bonus: 10,
    capacity_available: 10,
    sessions_per_week: 5,
  },
  levelFocused: {
    time_match: 25,
    preferred_trainer: 15,
    level_compatible: 35,
    priority_bonus: 5,
    capacity_available: 10,
    sessions_per_week: 10,
  },
};

interface RatingSpreadSettings {
  maxSpread: number | null;
  ratingSystem: string;
}

interface ScoringWeightsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultWeights?: ScoringWeights;
  defaultRatingSpread?: RatingSpreadSettings;
  onGenerate: (weights: ScoringWeights, saveAsDefault: boolean, ratingSpread?: RatingSpreadSettings) => Promise<void>;
  isGenerating?: boolean;
}

interface WeightSliderProps {
  label: string;
  helpText: string;
  value: number;
  onChange: (value: number) => void;
  icon: React.ReactNode;
}

function WeightSlider({ label, helpText, value, onChange, icon }: WeightSliderProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <Label className="text-sm font-medium">{label}</Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[200px]">
                <p className="text-xs">{helpText}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <span className="text-sm font-semibold text-primary min-w-[40px] text-right">
          {value}
        </span>
      </div>
      <Slider
        value={[value]}
        onValueChange={(v) => onChange(v[0])}
        min={0}
        max={100}
        step={5}
        className="w-full"
      />
    </div>
  );
}

// Default spread suggestions per rating system
const SUGGESTED_SPREADS: Record<string, number> = {
  knltb: 0.5,
  playtomic: 0.5,
  fep: 0.5,
  tennis_vlaanderen: 75,
  lta: 0.25,
};

export function ScoringWeightsDialog({
  open,
  onOpenChange,
  defaultWeights,
  defaultRatingSpread,
  onGenerate,
  isGenerating = false,
}: ScoringWeightsDialogProps) {
  const { t } = useTranslation("cycles");
  const [weights, setWeights] = useState<ScoringWeights>(
    defaultWeights || DEFAULT_WEIGHTS
  );
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  
  // Rating spread settings
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [ratingSpread, setRatingSpread] = useState<RatingSpreadSettings>(
    defaultRatingSpread || { maxSpread: null, ratingSystem: 'knltb' }
  );

  useEffect(() => {
    getRatingSystems().then(setRatingSystems);
  }, []);

  const selectedSystem = ratingSystems.find(s => s.code === ratingSpread.ratingSystem);

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  const updateWeight = (key: keyof ScoringWeights, value: number) => {
    setWeights((prev) => ({ ...prev, [key]: value }));
    setActivePreset(null);
  };

  const applyPreset = (presetKey: string) => {
    setWeights(PRESETS[presetKey]);
    setActivePreset(presetKey);
  };

  const handleGenerate = async () => {
    await onGenerate(weights, saveAsDefault, ratingSpread.maxSpread ? ratingSpread : undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t("proposals.weights.title")}</DialogTitle>
          <DialogDescription>
            {t("proposals.weights.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Preset buttons */}
          <div className="flex gap-2">
            <Button
              variant={activePreset === "balanced" ? "default" : "outline"}
              size="sm"
              onClick={() => applyPreset("balanced")}
              className="flex-1"
            >
              <Zap className="h-3.5 w-3.5 mr-1.5" />
              {t("proposals.weights.presets.balanced")}
            </Button>
            <Button
              variant={activePreset === "timeFocused" ? "default" : "outline"}
              size="sm"
              onClick={() => applyPreset("timeFocused")}
              className="flex-1"
            >
              <Clock className="h-3.5 w-3.5 mr-1.5" />
              {t("proposals.weights.presets.timeFocused")}
            </Button>
            <Button
              variant={activePreset === "levelFocused" ? "default" : "outline"}
              size="sm"
              onClick={() => applyPreset("levelFocused")}
              className="flex-1"
            >
              <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
              {t("proposals.weights.presets.levelFocused")}
            </Button>
          </div>

          {/* Weight sliders */}
          <div className="space-y-5">
            <WeightSlider
              label={t("proposals.weights.timeMatch")}
              helpText={t("proposals.weights.timeMatchHelp")}
              value={weights.time_match}
              onChange={(v) => updateWeight("time_match", v)}
              icon={<Clock className="h-4 w-4 text-muted-foreground" />}
            />
            <WeightSlider
              label={t("proposals.weights.preferredTrainer")}
              helpText={t("proposals.weights.preferredTrainerHelp")}
              value={weights.preferred_trainer}
              onChange={(v) => updateWeight("preferred_trainer", v)}
              icon={<Users className="h-4 w-4 text-muted-foreground" />}
            />
            <WeightSlider
              label={t("proposals.weights.levelCompatible")}
              helpText={t("proposals.weights.levelCompatibleHelp")}
              value={weights.level_compatible}
              onChange={(v) => updateWeight("level_compatible", v)}
              icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
            />
            <WeightSlider
              label={t("proposals.weights.priorityBonus")}
              helpText={t("proposals.weights.priorityBonusHelp")}
              value={weights.priority_bonus}
              onChange={(v) => updateWeight("priority_bonus", v)}
              icon={<Zap className="h-4 w-4 text-muted-foreground" />}
            />
            <WeightSlider
              label={t("proposals.weights.capacityAvailable")}
              helpText={t("proposals.weights.capacityAvailableHelp")}
              value={weights.capacity_available}
              onChange={(v) => updateWeight("capacity_available", v)}
              icon={<LayoutGrid className="h-4 w-4 text-muted-foreground" />}
            />
            <WeightSlider
              label={t("proposals.weights.sessionsPerWeek")}
              helpText={t("proposals.weights.sessionsPerWeekHelp")}
              value={weights.sessions_per_week}
              onChange={(v) => updateWeight("sessions_per_week", v)}
              icon={<CalendarDays className="h-4 w-4 text-muted-foreground" />}
            />
          </div>

          {/* Total indicator */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <span className="text-sm font-medium">{t("proposals.weights.total")}</span>
            <span
              className={cn(
                "text-lg font-bold",
                totalWeight === 0 ? "text-destructive" : "text-primary"
              )}
            >
              {totalWeight}
            </span>
          </div>

          <Separator />

          {/* Rating Spread Settings */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-muted-foreground" />
              <Label className="text-sm font-medium">{t("proposals.weights.ratingSettings")}</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[250px]">
                    <p className="text-xs">{t("proposals.weights.maxRatingSpreadHelp")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("proposals.weights.ratingSystem")}</Label>
                <Select
                  value={ratingSpread.ratingSystem}
                  onValueChange={(value) => setRatingSpread(prev => ({
                    ...prev,
                    ratingSystem: value,
                    maxSpread: SUGGESTED_SPREADS[value] || null
                  }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ratingSystems.map(sys => (
                      <SelectItem key={sys.code} value={sys.code}>
                        {sys.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("proposals.weights.maxRatingSpread")}</Label>
                <Input
                  type="number"
                  step={selectedSystem?.step || 0.1}
                  min={0}
                  value={ratingSpread.maxSpread ?? ''}
                  onChange={(e) => setRatingSpread(prev => ({
                    ...prev,
                    maxSpread: e.target.value ? parseFloat(e.target.value) : null
                  }))}
                  placeholder={t("proposals.weights.spreadPlaceholder")}
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {ratingSpread.maxSpread
                ? `Players with ratings more than ${ratingSpread.maxSpread} apart won't be grouped together`
                : 'Leave empty to skip rating spread check'}
            </p>
          </div>

          {/* Save as default checkbox */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="saveDefault"
              checked={saveAsDefault}
              onCheckedChange={(checked) => setSaveAsDefault(checked === true)}
            />
            <label
              htmlFor="saveDefault"
              className="text-sm text-muted-foreground cursor-pointer"
            >
              {t("proposals.weights.saveAsDefault")}
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isGenerating}
          >
            {t("common:cancel", "Cancel")}
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || totalWeight === 0}
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("proposals.generating")}
              </>
            ) : (
              t("proposals.weights.generate")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
