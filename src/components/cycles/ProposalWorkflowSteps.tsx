import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WorkflowStep = 'registrations' | 'review-links' | 'generate' | 'review-edit' | 'approve';
type StepStatus = 'completed' | 'active' | 'upcoming';

interface StepDef {
  id: WorkflowStep;
  label: string;
  description: string;
  status: StepStatus;
}

interface ProposalWorkflowStepsProps {
  activeStep: WorkflowStep;
  onStepClick: (step: WorkflowStep) => void;
  registrationsCount: number;
  pendingLinkActions: number;
  newCount: number;
  proposedCount: number;
  confirmedCount: number;
}

export default function ProposalWorkflowSteps({
  activeStep,
  onStepClick,
  registrationsCount,
  pendingLinkActions,
  newCount,
  proposedCount,
  confirmedCount,
}: ProposalWorkflowStepsProps) {
  const { t } = useTranslation('cycles');

  const hasRegistrations = registrationsCount > 0;
  const linksReviewed = pendingLinkActions === 0;
  const hasProposals = proposedCount > 0;
  const allConfirmed = confirmedCount > 0 && newCount === 0 && proposedCount === 0;

  const getStatus = (step: WorkflowStep): StepStatus => {
    switch (step) {
      case 'registrations':
        if (hasRegistrations) return activeStep === 'registrations' ? 'active' : 'completed';
        return 'active';
      case 'review-links':
        if (!hasRegistrations) return 'upcoming';
        if (linksReviewed && (hasProposals || activeStep === 'generate' || activeStep === 'review-edit' || activeStep === 'approve'))
          return 'completed';
        if (activeStep === 'review-links') return 'active';
        return linksReviewed ? 'completed' : 'active';
      case 'generate':
        if (!hasRegistrations) return 'upcoming';
        if (hasProposals || allConfirmed) return 'completed';
        if (activeStep === 'generate') return 'active';
        if (linksReviewed && !hasProposals) return activeStep === 'registrations' || activeStep === 'review-links' ? 'upcoming' : 'active';
        return 'upcoming';
      case 'review-edit':
        if (allConfirmed) return 'completed';
        if (hasProposals) return activeStep === 'review-edit' ? 'active' : (activeStep === 'approve' ? 'completed' : 'upcoming');
        return 'upcoming';
      case 'approve':
        if (allConfirmed) return 'completed';
        if (activeStep === 'approve') return 'active';
        return 'upcoming';
      default:
        return 'upcoming';
    }
  };

  const steps: StepDef[] = [
    {
      id: 'registrations',
      label: t('workflow.registrations', { defaultValue: 'Registrations' }),
      description: t('workflow.registrationsDesc', { defaultValue: '{{count}} registered', count: registrationsCount }),
      status: getStatus('registrations'),
    },
    {
      id: 'review-links',
      label: t('workflow.reviewLinks', { defaultValue: 'Review Links' }),
      description: pendingLinkActions > 0
        ? t('workflow.reviewLinksDesc', { defaultValue: '{{count}} action(s) pending', count: pendingLinkActions })
        : t('workflow.reviewLinksDone', { defaultValue: 'All clear' }),
      status: getStatus('review-links'),
    },
    {
      id: 'generate',
      label: t('workflow.generate', { defaultValue: 'Generate' }),
      description: t('workflow.generateDesc', { defaultValue: '{{count}} new requests', count: newCount }),
      status: getStatus('generate'),
    },
    {
      id: 'review-edit',
      label: t('workflow.review', { defaultValue: 'Review & Edit' }),
      description: t('workflow.reviewDesc', { defaultValue: '{{count}} proposals', count: proposedCount }),
      status: getStatus('review-edit'),
    },
    {
      id: 'approve',
      label: t('workflow.approve', { defaultValue: 'Approve & Book' }),
      description: t('workflow.approveDesc', { defaultValue: '{{count}} confirmed', count: confirmedCount }),
      status: getStatus('approve'),
    },
  ];

  const isClickable = (step: StepDef) => step.status !== 'upcoming';

  return (
    <nav className="w-full">
      <ol className="flex flex-col sm:flex-row gap-0">
        {steps.map((step, idx) => {
          const clickable = isClickable(step);
          const isActive = activeStep === step.id;
          const stepNumber = idx + 1;

          return (
            <li key={step.id} className="flex-1 flex items-stretch">
              <button
                type="button"
                onClick={() => clickable && onStepClick(step.id)}
                disabled={!clickable}
                className={cn(
                  'flex items-center gap-3 w-full px-4 py-3 text-left transition-colors rounded-lg',
                  isActive && 'bg-primary/5 ring-1 ring-primary/20',
                  clickable && !isActive && 'hover:bg-muted/50',
                  !clickable && 'opacity-50 cursor-not-allowed',
                )}
              >
                {/* Circle */}
                <div
                  className={cn(
                    'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors',
                    step.status === 'completed' && 'bg-primary border-primary text-primary-foreground',
                    step.status === 'active' && isActive && 'border-primary text-primary bg-primary/10',
                    step.status === 'active' && !isActive && 'border-primary/60 text-primary/60 bg-primary/5',
                    step.status === 'upcoming' && 'border-muted-foreground/30 text-muted-foreground/50 bg-muted/50',
                  )}
                >
                  {step.status === 'completed' ? <Check className="h-4 w-4" /> : stepNumber}
                </div>

                {/* Text */}
                <div className="flex flex-col min-w-0">
                  <span className={cn(
                    'text-sm font-medium leading-tight truncate',
                    step.status === 'upcoming' && 'text-muted-foreground/60',
                    isActive && 'text-primary',
                  )}>
                    {step.label}
                  </span>
                  <span className="text-xs text-muted-foreground leading-tight truncate">
                    {step.description}
                  </span>
                </div>
              </button>

              {/* Connector line (hidden on last + on mobile) */}
              {idx < steps.length - 1 && (
                <div className="hidden sm:flex items-center px-1">
                  <div className={cn(
                    'w-6 h-px',
                    steps[idx + 1].status !== 'upcoming' ? 'bg-primary/40' : 'bg-muted-foreground/20',
                  )} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
