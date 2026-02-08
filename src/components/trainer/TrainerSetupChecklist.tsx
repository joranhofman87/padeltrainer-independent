import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronUp, ArrowRight, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { type AcademyPaymentInfo } from '@/lib/academyTrainerPayments';

interface SetupStatus {
  profileComplete: boolean;
  hasLessons: boolean;
  hasAvailability: boolean;
  paymentsComplete: boolean;
  hasPlayers: boolean;
  academyPaymentInfo?: AcademyPaymentInfo;
}

interface TrainerSetupChecklistProps {
  setupStatus: SetupStatus;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigate: (path: string) => void;
}

export function TrainerSetupChecklist({ 
  setupStatus, 
  isExpanded, 
  onToggle, 
  onNavigate 
}: TrainerSetupChecklistProps) {
  const { t } = useTranslation('trainer');
  const academyInfo = setupStatus.academyPaymentInfo;
  
  let paymentLabel = 'Connect payment account or setup manual payments';
  let paymentSubLabel = '';
  
  if (academyInfo?.isAcademyTrainer && academyInfo?.academyChargesEnabled) {
    paymentLabel = t('dashboard.setup.steps.payments.academyManaged', { academyName: academyInfo.academyName || 'Your academy' });
    paymentSubLabel = t('dashboard.setup.steps.payments.academyManagedDescription');
  } else if (academyInfo?.isAcademyTrainer && !academyInfo?.academyChargesEnabled) {
    paymentLabel = t('academyPayments.academyNeedsSetup', { academyName: academyInfo.academyName || 'Your academy' });
  }
  
  const steps = [
    { key: 'profileComplete', label: 'Complete your profile essentials', route: '/trainer/profile', complete: setupStatus.profileComplete },
    { key: 'hasAvailability', label: 'Add 3 more time slots', route: '/trainer/calendar', complete: setupStatus.hasAvailability },
    { key: 'hasPlayers', label: 'Add your existing players', route: '/trainer/players', complete: setupStatus.hasPlayers },
    { key: 'paymentsComplete', label: paymentLabel, subLabel: paymentSubLabel, route: '/trainer/earnings', complete: setupStatus.paymentsComplete, isAcademyManaged: academyInfo?.isAcademyTrainer && academyInfo?.academyChargesEnabled },
    { key: 'isPublished', label: 'Publish your profile', route: '/trainer/settings', complete: false },
  ];

  const completedCount = steps.filter(s => s.complete).length;
  const totalSteps = steps.length;

  return (
    <Card className="border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-950/20 mb-8">
      <Collapsible open={isExpanded} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-orange-100/50 dark:hover:bg-orange-900/20 transition-colors rounded-t-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">🚀</span>
                <div>
                  <CardTitle className="text-orange-700 dark:text-orange-400">
                    Complete Your Setup
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {completedCount}/{totalSteps} steps complete
                  </CardDescription>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="shrink-0">
                {isExpanded ? (
                  <ChevronUp className="h-5 w-5 text-orange-600" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-orange-600" />
                )}
              </Button>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-2 bg-orange-200 dark:bg-orange-900 rounded-full overflow-hidden">
              <div 
                className="h-full bg-orange-500 transition-all duration-300"
                style={{ width: `${(completedCount / totalSteps) * 100}%` }}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground mb-4">
              Finish setting up your trainer profile to start receiving bookings
            </p>
            <div className="space-y-2">
              {steps.map((step, index) => (
                <button
                  key={step.key}
                  onClick={() => onNavigate(step.route)}
                  className="w-full flex items-center justify-between gap-3 p-3 bg-background rounded-lg hover:bg-muted/50 transition-colors text-left group"
                >
                  <div className="flex items-center gap-3">
                    {step.complete ? (
                      <div className={`h-6 w-6 rounded-full flex items-center justify-center ${(step as any).isClubManaged ? 'bg-blue-500' : 'bg-green-500'}`}>
                        {(step as any).isClubManaged ? (
                          <Building2 className="h-3.5 w-3.5 text-white" />
                        ) : (
                          <Check className="h-4 w-4 text-white" />
                        )}
                      </div>
                    ) : (
                      <div className="h-6 w-6 rounded-full border-2 border-orange-400 flex items-center justify-center text-xs font-medium text-orange-600">
                        {index + 1}
                      </div>
                    )}
                    <div className="flex flex-col">
                      <span className={step.complete ? 'text-muted-foreground line-through' : ''}>
                        {step.label}
                      </span>
                      {(step as any).subLabel && (
                        <span className="text-xs text-blue-600 dark:text-blue-400">
                          {(step as any).subLabel}
                        </span>
                      )}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
