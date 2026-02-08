import { Progress } from '@/components/ui/progress';

interface OnboardingProgressBarProps {
  currentStep: number;
  totalSteps: number;
}

export function OnboardingProgressBar({ currentStep, totalSteps }: OnboardingProgressBarProps) {
  const percentage = ((currentStep - 1) / (totalSteps - 1)) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Step {currentStep} of {totalSteps}
        </span>
        <span className="text-muted-foreground">
          {Math.round(percentage)}%
        </span>
      </div>
      <Progress value={percentage} className="h-2" />
    </div>
  );
}
