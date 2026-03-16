import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkles, Eye, CheckCheck, CalendarDays, Check, RotateCcw, UserPlus, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Cycle } from '@/lib/cycles';

type StepStatus = 'completed' | 'active' | 'upcoming';

interface Step {
  number: number;
  label: string;
  description: string;
  status: StepStatus;
  action?: React.ReactNode;
}

interface ProposalWorkflowStepsProps {
  cycles: Cycle[];
  selectedCycleId: string;
  onCycleChange: (value: string) => void;
  newCount: number;
  proposedCount: number;
  confirmedCount: number;
  onGenerate: () => void;
  onApproveAll: () => void;
  onReset: () => void;
  onAddManual: () => void;
  onShowOverview: () => void;
  isGenerating?: boolean;
  isResetting?: boolean;
}

export default function ProposalWorkflowSteps({
  cycles,
  selectedCycleId,
  onCycleChange,
  newCount,
  proposedCount,
  confirmedCount,
  onGenerate,
  onApproveAll,
  onReset,
  onAddManual,
  onShowOverview,
  isGenerating,
  isResetting,
}: ProposalWorkflowStepsProps) {
  const { t } = useTranslation('cycles');

  const cycleSelected = selectedCycleId !== 'all';

  // Determine step statuses based on data state
  const getStepStatuses = (): [StepStatus, StepStatus, StepStatus, StepStatus] => {
    if (!cycleSelected) {
      return ['active', 'upcoming', 'upcoming', 'upcoming'];
    }
    if (confirmedCount > 0 && newCount === 0 && proposedCount === 0) {
      return ['completed', 'completed', 'completed', 'completed'];
    }
    if (proposedCount > 0) {
      return ['completed', 'completed', 'active', 'upcoming'];
    }
    return ['completed', 'active', 'upcoming', 'upcoming'];
  };

  const [s1, s2, s3, s4] = getStepStatuses();

  const steps: Step[] = [
    {
      number: 1,
      label: t('workflow.selectCycle', { defaultValue: 'Select registration' }),
      description: cycleSelected
        ? cycles.find(c => c.id === selectedCycleId)?.name || ''
        : t('workflow.selectCycleDesc', { defaultValue: 'Choose a registration period' }),
      status: s1,
      action: (
        <Select value={selectedCycleId} onValueChange={onCycleChange}>
          <SelectTrigger className="w-[200px] h-8 text-xs">
            <SelectValue placeholder={t('workflow.selectCyclePlaceholder', { defaultValue: 'Select...' })} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('intakeRequests.filters.all')} cycles</SelectItem>
            {cycles.map(cycle => (
              <SelectItem key={cycle.id} value={cycle.id}>{cycle.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      number: 2,
      label: t('workflow.generate', { defaultValue: 'Generate' }),
      description: t('workflow.generateDesc', { defaultValue: '{{count}} new requests', count: newCount }),
      status: s2,
      action: (
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={!cycleSelected || newCount === 0}
          className="h-7 text-xs"
        >
          <Sparkles className="h-3 w-3 mr-1" />
          {t('proposals.generateAll', { defaultValue: 'Generate' })}
        </Button>
      ),
    },
    {
      number: 3,
      label: t('workflow.review', { defaultValue: 'Review & Edit' }),
      description: t('workflow.reviewDesc', { defaultValue: '{{count}} proposals', count: proposedCount }),
      status: s3,
      action: proposedCount > 0 ? (
        <div className="flex gap-1.5">
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
          <Button
            size="sm"
            onClick={onShowOverview}
            className="h-7 text-xs"
          >
            <Eye className="h-3 w-3 mr-1" />
            {t('workflow.continueToOverview', { defaultValue: 'Continue' })}
          </Button>
        </div>
      ) : undefined,
    },
    {
      number: 4,
      label: t('workflow.approve', { defaultValue: 'Approve & Book' }),
      description: t('workflow.approveDesc', { defaultValue: '{{count}} confirmed', count: confirmedCount }),
      status: s4,
      action: s4 === 'active' && proposedCount > 0 ? (
        <Button
          size="sm"
          onClick={onShowOverview}
          className="h-7 text-xs"
        >
          <ClipboardList className="h-3 w-3 mr-1" />
          {t('workflow.viewOverview', { defaultValue: 'View overview' })}
        </Button>
      ) : undefined,
    },
  ];

  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:gap-0 sm:items-start">
      {steps.map((step, idx) => (
        <React.Fragment key={step.number}>
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

        </React.Fragment>
      ))}
    </div>
  );
}
