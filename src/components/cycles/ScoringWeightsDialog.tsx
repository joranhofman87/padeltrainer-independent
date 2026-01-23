import { useState } from "react";
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
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Info, Zap, Clock, Users, TrendingUp, LayoutGrid } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ScoringWeights {
  time_match: number;
  preferred_trainer: number;
  level_compatible: number;
  priority_bonus: number;
  capacity_available: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  time_match: 40,
  preferred_trainer: 20,
  level_compatible: 20,
  priority_bonus: 10,
  capacity_available: 10,
};

const PRESETS: Record<string, ScoringWeights> = {
  balanced: {
    time_match: 40,
    preferred_trainer: 20,
    level_compatible: 20,
    priority_bonus: 10,
    capacity_available: 10,
  },
  timeFocused: {
    time_match: 60,
    preferred_trainer: 10,
    level_compatible: 15,
    priority_bonus: 10,
    capacity_available: 5,
  },
  levelFocused: {
    time_match: 25,
    preferred_trainer: 15,
    level_compatible: 40,
    priority_bonus: 10,
    capacity_available: 10,
  },
};

interface ScoringWeightsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultWeights?: ScoringWeights;
  onGenerate: (weights: ScoringWeights, saveAsDefault: boolean) => Promise<void>;
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

export function ScoringWeightsDialog({
  open,
  onOpenChange,
  defaultWeights,
  onGenerate,
  isGenerating = false,
}: ScoringWeightsDialogProps) {
  const { t } = useTranslation("cycles");
  const [weights, setWeights] = useState<ScoringWeights>(
    defaultWeights || DEFAULT_WEIGHTS
  );
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [activePreset, setActivePreset] = useState<string | null>(null);

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
    await onGenerate(weights, saveAsDefault);
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
