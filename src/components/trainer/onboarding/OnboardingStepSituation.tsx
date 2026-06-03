import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type {
  LessonsPerWeekRange,
  OnboardingResponsesRow,
  PlayerCountRange,
  TrainerType,
} from '@/lib/onboardingResponses';

const TRAINER_TYPES: TrainerType[] = ['independent', 'club_trainer', 'academy_owner'];
const LESSONS_RANGES: LessonsPerWeekRange[] = ['none', '1-5', '6-15', '16-30', '30+'];
const PLAYER_RANGES: PlayerCountRange[] = ['0', '1-10', '11-30', '30+'];

export interface SituationFormValues {
  trainer_type: TrainerType | null;
  lessons_per_week_range: LessonsPerWeekRange | null;
  player_count_range: PlayerCountRange | null;
  primary_city: string;
}

interface OnboardingStepSituationProps {
  initialData: OnboardingResponsesRow | null;
  onBack?: () => void;
  onNext: (values: SituationFormValues) => Promise<void>;
  isSaving: boolean;
}

function mapInitial(row: OnboardingResponsesRow | null): SituationFormValues {
  return {
    trainer_type: (row?.trainer_type as TrainerType | null) ?? null,
    lessons_per_week_range: (row?.lessons_per_week_range as LessonsPerWeekRange | null) ?? null,
    player_count_range: (row?.player_count_range as PlayerCountRange | null) ?? null,
    primary_city: row?.primary_city ?? '',
  };
}

function OptionButton({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors',
        selected
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-border bg-card text-foreground hover:border-primary/40 hover:bg-muted/40',
      )}
    >
      {label}
    </button>
  );
}

export function OnboardingStepSituation({
  initialData,
  onBack,
  onNext,
  isSaving,
}: OnboardingStepSituationProps) {
  const { t } = useTranslation('onboarding');
  const [values, setValues] = useState<SituationFormValues>(() => mapInitial(initialData));

  useEffect(() => {
    setValues(mapInitial(initialData));
  }, [initialData]);

  const canProceed =
    !!values.trainer_type &&
    !!values.lessons_per_week_range &&
    !!values.player_count_range &&
    values.primary_city.trim().length > 0;

  const handleSubmit = async () => {
    if (!canProceed) return;
    await onNext(values);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center sm:text-left">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('spiced.situation.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('spiced.situation.subtitle')}</p>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label>{t('spiced.situation.trainerTypeLabel')}</Label>
          <div className="grid gap-2">
            {TRAINER_TYPES.map((type) => (
              <OptionButton
                key={type}
                selected={values.trainer_type === type}
                label={t(`spiced.situation.trainerTypes.${type}`)}
                onClick={() => setValues((v) => ({ ...v, trainer_type: type }))}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t('spiced.situation.lessonsPerWeekLabel')}</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {LESSONS_RANGES.map((range) => (
              <OptionButton
                key={range}
                selected={values.lessons_per_week_range === range}
                label={t(`spiced.situation.lessonsPerWeek.${range}`)}
                onClick={() => setValues((v) => ({ ...v, lessons_per_week_range: range }))}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t('spiced.situation.playerCountLabel')}</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PLAYER_RANGES.map((range) => (
              <OptionButton
                key={range}
                selected={values.player_count_range === range}
                label={t(`spiced.situation.playerCount.${range}`)}
                onClick={() => setValues((v) => ({ ...v, player_count_range: range }))}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="primary_city">{t('spiced.situation.primaryCityLabel')}</Label>
          <Input
            id="primary_city"
            value={values.primary_city}
            onChange={(e) => setValues((v) => ({ ...v, primary_city: e.target.value }))}
            placeholder={t('spiced.situation.primaryCityPlaceholder')}
            autoComplete="address-level2"
          />
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {onBack ? (
          <Button type="button" variant="outline" onClick={onBack} disabled={isSaving}>
            {t('spiced.common.back')}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          size="lg"
          className="w-full sm:w-auto"
          disabled={!canProceed || isSaving}
          onClick={handleSubmit}
        >
          {isSaving ? t('spiced.common.saving') : t('spiced.common.continue')}
        </Button>
      </div>
    </div>
  );
}
