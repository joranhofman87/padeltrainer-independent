import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock, Crown, Check, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface SubscriptionOverlayProps {
  roleName: 'trainer' | 'club' | 'academy';
  subscriptionPath: string;
  pricing: {
    monthly: number;
    yearly: number;
  };
  features: string[];
  trialDaysRemaining?: number;
  isTrialExpired: boolean;
}

export function SubscriptionOverlay({
  roleName,
  subscriptionPath,
  pricing,
  features,
  trialDaysRemaining = 0,
  isTrialExpired,
}: SubscriptionOverlayProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();

  const handleUpgrade = () => {
    navigate(subscriptionPath);
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4">
      <Card className="w-full max-w-lg shadow-2xl border-2 border-primary/20">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            {isTrialExpired ? (
              <Lock className="h-8 w-8 text-primary" />
            ) : (
              <Clock className="h-8 w-8 text-primary" />
            )}
          </div>
          <CardTitle className="text-2xl">
            {isTrialExpired
              ? t('subscriptionOverlay.trialExpired', 'Your trial has expired')
              : t('subscriptionOverlay.title', 'Subscription Required')}
          </CardTitle>
          <p className="text-muted-foreground mt-2">
            {isTrialExpired
              ? t('subscriptionOverlay.expiredDescription', 'Subscribe to continue using all features')
              : trialDaysRemaining > 0
              ? t('subscriptionOverlay.trialDaysRemaining', '{{days}} days left in your trial', { days: trialDaysRemaining })
              : t('subscriptionOverlay.description', 'Upgrade to access all features')}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Pricing */}
          <div className="text-center">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-4xl font-bold">€{pricing.monthly}</span>
              <span className="text-muted-foreground">{t('subscriptionOverlay.perMonth', '/month')}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t('subscriptionOverlay.billedAnnually', 'Billed annually at €{{amount}}', { amount: pricing.yearly })}
            </p>
          </div>

          {/* Features */}
          <div className="space-y-3">
            <p className="font-medium text-sm text-center">
              {t('subscriptionOverlay.features', "What you'll get:")}
            </p>
            <ul className="space-y-2">
              {features.map((feature, index) => (
                <li key={index} className="flex items-center gap-3">
                  <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Check className="h-3 w-3 text-primary" />
                  </div>
                  <span className="text-sm">{feature}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* CTA */}
          <Button onClick={handleUpgrade} className="w-full" size="lg">
            <Crown className="h-4 w-4 mr-2" />
            {t('subscriptionOverlay.upgradeNow', 'Upgrade Now')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
