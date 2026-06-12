import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Check,
  Crown,
  Zap,
  Users,
  Calendar,
  BarChart3,
  MessageSquare,
  Shield,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { useTrainerPlans, SubscriptionPlan } from '@/hooks/usePricingPlans';
import { logger } from '@/lib/logger';
import { trackEvent } from '@/lib/tracking';
import { formatDate } from '@/lib/format';
import { useTranslation } from 'react-i18next';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';
import { cn } from '@/lib/utils';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

const UPGRADE_FEATURE_KEYS = [
  'lowerFees',
  'visibility',
  'analytics',
  'scheduling',
  'support',
  'verified',
] as const;

const UPGRADE_FEATURE_ICONS = [Zap, Users, BarChart3, Calendar, MessageSquare, Shield];

export default function TrainerSubscription() {
  const { t } = useTranslation(['trainer', 'marketing']);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, role, loading, subscription, refreshSubscription, session } = useAuth();
  const { toast } = useToast();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);

  const { data: plans, isLoading: loadingPlans, isError: plansError, refetch: refetchPlans } = useTrainerPlans();

  useEffect(() => {
    const success = searchParams.get('success');
    const canceled = searchParams.get('canceled');

    if (success === 'true') {
      trackEvent('subscription_activated', { plan: subscription?.tier || 'unknown' });
      toast({
        title: t('subscriptionPage.toastActivatedTitle'),
        description: t('subscriptionPage.toastActivatedDescription'),
      });
      refreshSubscription();
      window.history.replaceState({}, '', '/subscription');
    } else if (canceled === 'true') {
      toast({
        title: t('subscriptionPage.toastCanceledTitle'),
        description: t('subscriptionPage.toastCanceledDescription'),
        variant: 'destructive',
      });
      window.history.replaceState({}, '', '/subscription');
    }
  }, [searchParams, toast, refreshSubscription, subscription?.tier, t]);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/app/auth');
      } else if (role !== 'trainer') {
        navigate('/app/player');
      }
    }
  }, [user, role, loading, navigate]);

  const currentPlan = subscription?.tier || 'starter';

  useEffect(() => {
    if (!loading && !loadingPlans) {
      trackEvent('subscription_page_viewed', { current_plan: currentPlan });
    }
  }, [currentPlan, loading, loadingPlans]);

  const highlightedPlan = useMemo(
    () => plans?.find((p) => p.is_highlighted) ?? plans?.find((p) => p.tier !== 'starter' && p.monthly_price > 0),
    [plans],
  );

  const handleSelectPlan = async (plan: SubscriptionPlan) => {
    if (plan.tier === 'starter') {
      toast({
        title: t('subscriptionPage.toastDowngradeTitle'),
        description: t('subscriptionPage.toastDowngradeDescription'),
      });
      return;
    }

    trackEvent('subscription_checkout_started', { plan: plan.tier, billing_cycle: billingCycle });
    setProcessingPlan(plan.id);

    try {
      logger.info('Starting Stripe checkout for subscription', {
        component: 'TrainerSubscription',
        planId: plan.tier,
        billingCycle,
      });

      const { data, error } = await supabase.functions.invoke('create-stripe-checkout', {
        body: { type: 'trainer', planId: plan.tier, billingCycle },
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (error) throw error;

      if (data?.hasActiveSubscription) {
        toast({
          title: t('subscriptionPage.toastSamePlanTitle'),
          description: data.message,
        });
        setProcessingPlan(null);
        return;
      }

      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      throw new Error('No checkout URL returned');
    } catch (err) {
      logger.error('Subscription checkout failed', err as Error, {
        component: 'TrainerSubscription',
        plan: plan.tier,
      });
      toast({
        title: t('subscriptionPage.toastErrorTitle'),
        description: t('subscriptionPage.toastCheckoutError'),
        variant: 'destructive',
      });
      setProcessingPlan(null);
    }
  };

  const handleManageSubscription = async () => {
    setLoadingPortal(true);

    try {
      const { data, error } = await supabase.functions.invoke('customer-portal', {
        body: { type: 'trainer' },
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (error) throw error;

      if (data?.url) {
        window.open(data.url, '_blank');
      } else {
        throw new Error('No portal URL returned');
      }
    } catch (err) {
      logger.error('Customer portal failed', err as Error, {
        component: 'TrainerSubscription',
      });
      toast({
        title: t('subscriptionPage.toastErrorTitle'),
        description: t('subscriptionPage.toastPortalError'),
        variant: 'destructive',
      });
    } finally {
      setLoadingPortal(false);
    }
  };

  const planStatusHint =
    currentPlan === 'starter'
      ? t('subscriptionPage.upgradeHint')
      : subscription?.subscriptionEnd
        ? t('subscriptionPage.nextBilling', { date: formatDate(subscription.subscriptionEnd, 'd MMMM yyyy') })
        : t('subscriptionPage.activeHint');

  const primaryHeaderAction =
    currentPlan !== 'starter'
      ? {
          label: t('subscriptionPage.manageSubscription'),
          onClick: handleManageSubscription,
          icon: ExternalLink,
          disabled: loadingPortal,
          loading: loadingPortal,
        }
      : highlightedPlan
        ? {
            label: t('subscriptionPage.upgrade'),
            onClick: () => handleSelectPlan(highlightedPlan),
            icon: Crown,
            disabled: processingPlan !== null,
            loading: processingPlan === highlightedPlan.id,
          }
        : undefined;

  const getPlanButtonLabel = (plan: SubscriptionPlan) => {
    if (processingPlan === plan.id) return t('subscriptionPage.processing');
    if (currentPlan === plan.tier) return t('subscriptionPage.currentPlanButton');
    if (plan.monthly_price === 0) return t('subscriptionPage.freePlan');
    if (subscription?.isSubscribed && currentPlan !== 'starter') return t('subscriptionPage.switchPlan');
    return t('subscriptionPage.upgrade');
  };

  if (loading || loadingPlans) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5 py-2">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="grid gap-6 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[380px] rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 py-2">
      <TrainerPageHeader
        title={t('subscriptionPage.title')}
        description={t('subscriptionPage.subtitle')}
        primaryAction={primaryHeaderAction}
      />

      <Card className="border-border/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--navy-50))]">
                <Crown className="h-5 w-5 text-[hsl(var(--navy-600))]" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-base font-semibold text-[hsl(var(--navy-900))]">
                    {t('subscriptionPage.currentPlan')}
                  </h2>
                  <Badge variant="secondary" className="capitalize">
                    {currentPlan}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{planStatusHint}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-center">
        <div className="inline-flex items-center gap-1 rounded-lg border border-border/80 bg-muted/40 p-0.5">
          <Button
            variant={billingCycle === 'monthly' ? 'default' : 'ghost'}
            size="sm"
            className={cn(
              billingCycle === 'monthly' && 'bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]',
            )}
            onClick={() => setBillingCycle('monthly')}
          >
            {t('subscriptionPage.monthly')}
          </Button>
          <Button
            variant={billingCycle === 'yearly' ? 'default' : 'ghost'}
            size="sm"
            className={cn(
              'gap-2',
              billingCycle === 'yearly' && 'bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]',
            )}
            onClick={() => setBillingCycle('yearly')}
          >
            {t('subscriptionPage.yearly')}
            <Badge variant="outline" className="border-[hsl(var(--brand-200))] bg-[hsl(var(--brand-50))] text-xs text-[hsl(var(--brand-700))]">
              {t('subscriptionPage.yearlySave')}
            </Badge>
          </Button>
        </div>
      </div>

      {plansError ? (
        <QueryErrorState className="mx-auto max-w-5xl" onRetry={() => refetchPlans()} />
      ) : (
      <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-3">
        {plans?.map((plan) => (
          <Card
            key={plan.id}
            className={cn(
              'relative border-border/80 shadow-sm',
              plan.is_highlighted && 'border-[hsl(var(--brand-300))] ring-1 ring-[hsl(var(--brand-200))]',
              currentPlan === plan.tier && 'ring-2 ring-[hsl(var(--navy-300))]',
            )}
          >
            {plan.badge && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <Badge className="bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-500))]">
                  {plan.badge}
                </Badge>
              </div>
            )}
            {currentPlan === plan.tier && (
              <div className="absolute -top-3 right-4">
                <Badge variant="outline" className="border-[hsl(var(--navy-200))] bg-background text-[hsl(var(--navy-700))]">
                  {t('subscriptionPage.yourPlan')}
                </Badge>
              </div>
            )}
            <CardHeader className="pt-8 text-center">
              <CardTitle className="font-display text-2xl">{plan.name}</CardTitle>
              <CardDescription>{plan.description}</CardDescription>
              <div className="pt-4">
                <span className="font-display text-4xl font-semibold tabular-nums text-[hsl(var(--navy-900))]">
                  €{billingCycle === 'yearly' ? plan.yearly_price : plan.monthly_price}
                </span>
                <span className="text-muted-foreground">
                  /{billingCycle === 'yearly' ? t('subscriptionPage.perYear') : t('subscriptionPage.perMonth')}
                </span>
                {billingCycle === 'yearly' && plan.monthly_price > 0 && (
                  <p className="mt-1 text-sm font-medium text-[hsl(var(--brand-600))]">
                    {t('subscriptionPage.savePerYear', {
                      amount: Math.round(plan.monthly_price * 12 - plan.yearly_price),
                    })}
                  </p>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Separator />
              <ul className="space-y-4">
                {(
                  t(`pricing.trainers.plans.${plan.tier}.featureList`, {
                    returnObjects: true,
                    ns: 'marketing',
                  }) as { title: string; description: string }[]
                )?.map?.((feature, index) => (
                  <li key={index} className="flex items-start gap-3">
                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--brand-600))]" />
                    <div>
                      <span className="block text-sm font-semibold">{feature.title}</span>
                      <span className="text-xs text-muted-foreground">{feature.description}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button
                className={cn(
                  'w-full',
                  plan.is_highlighted && currentPlan !== plan.tier && 'bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]',
                )}
                variant={plan.is_highlighted ? 'default' : 'outline'}
                disabled={currentPlan === plan.tier || processingPlan !== null}
                onClick={() => handleSelectPlan(plan)}
              >
                {processingPlan === plan.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {getPlanButtonLabel(plan)}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      )}

      <Card className="mx-auto max-w-4xl border-border/80 shadow-sm">
        <CardHeader>
          <CardTitle className="font-display text-lg text-[hsl(var(--navy-900))]">
            {t('subscriptionPage.whyUpgrade')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {UPGRADE_FEATURE_KEYS.map((key, index) => {
              const Icon = UPGRADE_FEATURE_ICONS[index];
              return (
                <div key={key} className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--navy-50))]">
                    <Icon className="h-4 w-4 text-[hsl(var(--navy-600))]" />
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-[hsl(var(--navy-900))]">
                      {t(`subscriptionPage.features.${key}.title`)}
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      {t(`subscriptionPage.features.${key}.description`)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
