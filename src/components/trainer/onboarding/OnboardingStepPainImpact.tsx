import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  CalendarX,
  ClipboardList,
  CreditCard,
  Sparkles,
  UserX,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  PAIN_OPTIONS,
  getEstimatedAnnualHours,
  type AdminHoursRange,
  type OnboardingResponsesRow,
  type PainTag,
} from '@/lib/onboardingResponses';
import { toOnboardingNsKey } from '@/components/trainer/onboarding/onboardingSpicedUtils';

const ADMIN_RANGES: AdminHoursRange[] = ['<1', '1-3', '3-6', '6+'];

const PAIN_ICONS: Record<string, LucideIcon> = {
  CreditCard,
  Calendar,
  UserX,
  CalendarX,
  Users,
  ClipboardList,
  Sparkles,
};

const MAX_PAINS = 2;

interface OnboardingStepPainImpactProps {
  initialData: OnboardingResponsesRow | null;
  onBack: () => void;
  onNext: (values: {
    primary_pains: PainTag[];
    admin_hours_per_week: AdminHoursRange;
  }) => Promise<void>;
  isSaving: boolean;
}

function OptionButton({
  selected,
  label,
  description,
  icon: Icon,
  onClick,
}: {
  selected: boolean;
  label: string;
  description?: string;
  icon?: LucideIcon;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:border-primary/40 hover:bg-muted/40',
      )}
    >
      {Icon ? (
        <div
          className={cn(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      ) : null}
      <div className="min-w-0 space-y-0.5">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </div>
    </button>
  );
}

export function OnboardingStepPainImpact({
  initialData,
  onBack,
  onNext,
  isSaving,
}: OnboardingStepPainImpactProps) {
  const { t } = useTranslation('onboarding');
  const [primaryPains, setPrimaryPains] = useState<PainTag[]>(
    () => (initialData?.primary_pains as PainTag[] | null) ?? [],
  );
  const [adminHours, setAdminHours] = useState<AdminHoursRange | null>(
    () => (initialData?.admin_hours_per_week as AdminHoursRange | null) ?? null,
  );

  useEffect(() => {
    setPrimaryPains((initialData?.primary_pains as PainTag[] | null) ?? []);
    setAdminHours((initialData?.admin_hours_per_week as AdminHoursRange | null) ?? null);
  }, [initialData]);

  const annualHours = useMemo(() => getEstimatedAnnualHours(adminHours), [adminHours]);

  const togglePain = (tag: PainTag) => {
    setPrimaryPains((current) => {
      if (current.includes(tag)) {
        return current.filter((p) => p !== tag);
      }
      if (current.length >= MAX_PAINS) {
        return [...current.slice(1), tag];
      }
      return [...current, tag];
    });
  };

  const canProceed = primaryPains.length >= 1 && adminHours != null;

  const handleSubmit = async () => {
    if (!canProceed || !adminHours) return;
    await onNext({ primary_pains: primaryPains, admin_hours_per_week: adminHours });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center sm:text-left">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {t('spiced.painImpact.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('spiced.painImpact.subtitle')}</p>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label>{t('spiced.painImpact.painsLabel')}</Label>
            <span className="text-xs text-muted-foreground">{t('spiced.painImpact.painsHint')}</span>
          </div>
          <div className="grid gap-2">
            {PAIN_OPTIONS.map((option) => {
              const Icon = option.iconName ? PAIN_ICONS[option.iconName] : undefined;
              const label = t(toOnboardingNsKey(option.labelKey));
              const description = option.descriptionKey
                ? t(toOnboardingNsKey(option.descriptionKey))
                : undefined;
              return (
                <OptionButton
                  key={option.id}
                  selected={primaryPains.includes(option.id)}
                  label={label}
                  description={description}
                  icon={Icon}
                  onClick={() => togglePain(option.id)}
                />
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t('spiced.painImpact.adminHoursLabel')}</Label>
          <div className="grid grid-cols-2 gap-2">
            {ADMIN_RANGES.map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setAdminHours(range)}
                className={cn(
                  'rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors',
                  adminHours === range
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/40',
                )}
              >
                {t(`spiced.painImpact.adminHours.${range}`)}
              </button>
            ))}
          </div>
          {annualHours != null ? (
            <p className="rounded-md border border-border/80 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {t('spiced.painImpact.annualHoursEstimate', { hours: annualHours })}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="outline" onClick={onBack} disabled={isSaving}>
          {t('spiced.common.back')}
        </Button>
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
