import { useTranslation } from 'react-i18next';
import { Progress } from '@/components/ui/progress';

interface OnboardingProgressIndicatorProps {
  currentStep: number;
  totalSteps: number;
}

export function OnboardingProgressIndicator({
  currentStep,
  totalSteps,
}: OnboardingProgressIndicatorProps) {
  const { t } = useTranslation('onboarding');
  const percentage = totalSteps > 1 ? ((currentStep - 1) / (totalSteps - 1)) * 100 : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">
          {t('spiced.progress.stepOf', { current: currentStep, total: totalSteps })}
        </span>
        <span className="text-muted-foreground tabular-nums">{Math.round(percentage)}%</span>
      </div>
      <Progress value={percentage} className="h-1.5 bg-muted" />
    </div>
  );
}
