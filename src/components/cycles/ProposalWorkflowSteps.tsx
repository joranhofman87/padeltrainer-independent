import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Sparkles, Eye, CheckCheck, CalendarDays, Check, RotateCcw, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';

type StepStatus = 'completed' | 'active' | 'upcoming';

interface Step {
  number: number;
  label: string;
  description: string;
  status: StepStatus;
  action?: React.ReactNode;
}

interface ProposalWorkflowStepsProps {
  newCount: number;
  proposedCount: number;
  confirmedCount: number;
  cycleSelected: boolean;
  onGenerate: () => void;
  onApproveAll: () => void;
  onReset: () => void;
  onAddManual: () => void;
  isGenerating?: boolean;
  isResetting?: boolean;
}

export default function ProposalWorkflowSteps({
  newCount,
  proposedCount,
  confirmedCount,
  cycleSelected,
  onGenerate,
  onApproveAll,
  onReset,
  onAddManual,
  isGenerating,
  isResetting,
}: ProposalWorkflowStepsProps) {
  const { t } = useTranslation('cycles');

  // Determine step statuses based on data state
  const getStepStatus = (): [StepStatus, StepStatus, StepStatus] => {
    if (confirmedCount > 0 && newCount === 0 && proposedCount === 0) {
      return ['completed', 'completed', 'active'];
    }
    if (confirmedCount > 0 && proposedCount > 0) {
      return ['completed', 'active', 'active'];
    }
    if (proposedCount > 0) {
      return ['completed', 'active', 'upcoming'];
    }
    return ['active', 'upcoming', 'upcoming'];
  };

  const [s1, s2, s3] = getStepStatus();

  const steps: Step[] = [
    {
      number: 1,
      label: t('workflow.generate', { defaultValue: 'Generate' }),
      description: t('workflow.generateDesc', { defaultValue: '{{count}} new requests', count: newCount }),
      status: s1,
      action: (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={onAddManual}
            className="h-7 text-xs"
          >
            <UserPlus className="h-3 w-3 mr-1" />
            {t('intakeRequests.addManual', { defaultValue: 'Add' })}
          </Button>
          <Button
            size="sm"
            onClick={onGenerate}
            disabled={!cycleSelected || newCount === 0}
            className="h-7 text-xs"
          >
            <Sparkles className="h-3 w-3 mr-1" />
            {t('proposals.generateAll', { defaultValue: 'Generate' })}
          </Button>
        </div>
      ),
    },
    {
      number: 2,
      label: t('workflow.review', { defaultValue: 'Review & Edit' }),
      description: t('workflow.reviewDesc', { defaultValue: '{{count}} proposals', count: proposedCount }),
      status: s2,
      action: proposedCount > 0 ? (
        <Button
          size="sm"
          variant="outline"
          onClick={onReset}
          disabled={isResetting}
          className="h-7 text-xs"
        >
          <RotateCcw className="h-3 w-3 mr-1" />
          {t('proposals.reset', { defaultValue: 'Reset' })}
        </Button>
      ) : undefined,
    },
    {
      number: 3,
      label: t('workflow.approve', { defaultValue: 'Approve & Book' }),
      description: t('workflow.approveDesc', { defaultValue: '{{count}} confirmed', count: confirmedCount }),
      status: s3,
      action: proposedCount > 0 ? (
        <Button
          size="sm"
          onClick={onApproveAll}
          className="h-7 text-xs"
        >
          <CheckCheck className="h-3 w-3 mr-1" />
          {t('proposals.approveAll', { defaultValue: 'Approve all' })}
        </Button>
      ) : undefined,
    },
  ];

  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:gap-0 sm:items-start">
      {steps.map((step, idx) => (
        <div key={step.number} className="flex items-start sm:flex-1 gap-3 sm:gap-0">
          {/* Step content */}
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Circle */}
            <div
              className={cn(
                'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors',
                step.status === 'completed' && 'bg-primary border-primary text-primary-foreground',
                step.status === 'active' && 'border-primary text-primary bg-primary/10',
                step.status === 'upcoming' && 'border-muted-foreground/30 text-muted-foreground/50 bg-muted/50',
              )}
            >
              {step.status === 'completed' ? <Check className="h-4 w-4" /> : step.number}
            </div>

            {/* Text + action */}
            <div className="flex flex-col gap-1 min-w-0">
              <span className={cn(
                'text-sm font-medium leading-tight',
                step.status === 'upcoming' && 'text-muted-foreground/60',
              )}>
                {step.label}
              </span>
              <span className="text-xs text-muted-foreground leading-tight">
                {step.description}
              </span>
              {step.status !== 'upcoming' && step.action && (
                <div className="mt-1">
                  {step.action}
                </div>
              )}
            </div>
          </div>

          {/* Connector line (desktop only, not after last) */}
          {idx < steps.length - 1 && (
            <div className="hidden sm:flex items-center px-2 pt-4">
              <div className={cn(
                'w-8 h-0.5',
                step.status === 'completed' ? 'bg-primary' : 'bg-muted-foreground/20',
              )} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
