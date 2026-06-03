import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  ArrowLeft, 
  Check, 
  Crown,
  Zap,
  Users,
  Calendar,
  BarChart3,
  MessageSquare,
  Shield,
  Star,
  Sparkles,
  Loader2,
  ExternalLink
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { useTrainerPlans, SubscriptionPlan } from '@/hooks/usePricingPlans';
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary';
import { logger } from '@/lib/logger';
import { trackEvent } from '@/lib/tracking';
import { useTranslation } from 'react-i18next';

export default function TrainerSubscription() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, role, loading, subscription, refreshSubscription, session } = useAuth();
  const { toast } = useToast();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);
  
  const { data: plans, isLoading: loadingPlans } = useTrainerPlans();

  // Handle success/cancel from Stripe checkout
  useEffect(() => {
    const success = searchParams.get('success');
    const canceled = searchParams.get('canceled');

    if (success === 'true') {
      trackEvent('subscription_activated', { plan: subscription?.tier || 'unknown' });
      toast({
        title: 'Subscription Activated! 🎉',
        description: 'Your subscription is now active. Enjoy your new features!',
      });
      refreshSubscription();
      window.history.replaceState({}, '', '/subscription');
    } else if (canceled === 'true') {
      toast({
        title: 'Checkout Canceled',
        description: 'Your subscription was not changed.',
        variant: 'destructive',
      });
      window.history.replaceState({}, '', '/subscription');
    }
  }, [searchParams, toast, refreshSubscription]);

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

  // Track page view with current plan context
  useEffect(() => {
    if (!loading && !loadingPlans) {
      trackEvent('subscription_page_viewed', { current_plan: currentPlan });
    }
  }, [currentPlan, loading, loadingPlans]);

  if (loading || loadingPlans) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6 py-2">
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

  const handleSelectPlan = async (plan: SubscriptionPlan) => {
    if (plan.tier === 'starter') {
      toast({
        title: 'Use Manage Subscription',
        description: 'To downgrade, please use the Manage Subscription button.',
      });
      return;
    }

    // planId no longer needed - Stripe checkout uses tier + billingCycle

    trackEvent('subscription_checkout_started', { plan: plan.tier, billing_cycle: billingCycle });
    setProcessingPlan(plan.id);

    try {
      logger.info('Starting Stripe checkout for subscription', { 
        component: 'TrainerSubscription', 
        planId: plan.tier, 
        billingCycle 
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
          title: 'Same Plan',
          description: data.message,
        });
        setProcessingPlan(null);
        return;
      }

      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      logger.error('Subscription checkout failed', err as Error, { 
        component: 'TrainerSubscription', 
        plan: plan.tier 
      });
      toast({
        title: 'Error',
        description: 'Failed to start checkout. Please try again.',
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
        component: 'TrainerSubscription' 
      });
      toast({
        title: 'Error',
        description: 'Failed to open subscription management. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoadingPortal(false);
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return null;
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 py-2">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/trainer')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-brand-50 p-2">
            <Crown className="h-5 w-5 text-brand-600" />
          </div>
          <h1 className="text-2xl font-display font-bold tracking-tight">Subscription Plans</h1>
        </div>
      </div>

      <div className="space-y-8">
        {/* Current Plan Banner */}
        <Card className="mb-8 border-primary/20">
          <CardContent className="p-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-full bg-primary/10">
                  <Crown className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-lg">Current Plan:</h3>
                    <Badge variant="secondary" className="capitalize">{currentPlan}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {currentPlan === 'starter' 
                      ? 'Upgrade to unlock more features and lower fees'
                      : subscription?.subscriptionEnd
                        ? `Next billing date: ${formatDate(subscription.subscriptionEnd)}`
                        : 'Your subscription is active'
                    }
                  </p>
                </div>
              </div>
              {currentPlan !== 'starter' && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleManageSubscription}
                  disabled={loadingPortal}
                >
                  {loadingPortal ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <ExternalLink className="h-4 w-4 mr-2" />
                  )}
                  Manage Subscription
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Billing Toggle */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-1 p-1 bg-muted rounded-lg">
            <Button
              variant={billingCycle === 'monthly' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setBillingCycle('monthly')}
            >
              Monthly
            </Button>
            <Button
              variant={billingCycle === 'yearly' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setBillingCycle('yearly')}
              className="gap-2"
            >
              Yearly
              <Badge variant="success" className="text-xs">
                Save 20%
              </Badge>
            </Button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto mb-12">
          {plans?.map((plan) => (
            <Card 
              key={plan.id}
              className={`relative ${plan.is_highlighted ? 'border-primary shadow-md md:scale-[1.02]' : ''} ${currentPlan === plan.tier ? 'ring-2 ring-primary' : ''}`}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className={plan.is_highlighted ? 'bg-primary' : 'bg-brand-500'}>
                    <Sparkles className="h-3 w-3 mr-1" />
                    {plan.badge}
                  </Badge>
                </div>
              )}
              {currentPlan === plan.tier && (
                <div className="absolute -top-3 right-4">
                  <Badge variant="outline" className="bg-background border-primary text-primary">
                    Your Plan
                  </Badge>
                </div>
              )}
              <CardHeader className="text-center pt-8">
                <CardTitle className="text-2xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                <div className="pt-4">
                  <span className="text-4xl font-bold">
                    €{billingCycle === 'yearly' ? plan.yearly_price : plan.monthly_price}
                  </span>
                  <span className="text-muted-foreground">
                    /{billingCycle === 'yearly' ? 'year' : 'month'}
                  </span>
                  {billingCycle === 'yearly' && plan.monthly_price > 0 && (
                    <p className="mt-1 text-sm font-medium text-[hsl(var(--success))]">
                      Save €{Math.round(plan.monthly_price * 12 - plan.yearly_price)}/year
                    </p>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Separator />
                <ul className="space-y-4">
                  {(t(`pricing.trainers.plans.${plan.tier}.featureList`, { returnObjects: true, ns: 'marketing' }) as { title: string; description: string }[])?.map?.((feature, index) => (
                    <li key={index} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold text-sm block">{feature.title}</span>
                        <span className="text-xs text-muted-foreground">{feature.description}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
              <CardFooter>
                <Button 
                  className="w-full" 
                  variant={plan.is_highlighted ? 'default' : 'outline'}
                  disabled={currentPlan === plan.tier || processingPlan !== null}
                  onClick={() => handleSelectPlan(plan)}
                >
                  {processingPlan === plan.id ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Processing...
                    </>
                  ) : currentPlan === plan.tier ? (
                    'Current Plan'
                  ) : plan.monthly_price === 0 ? (
                    'Free Plan'
                  ) : subscription?.isSubscribed && currentPlan !== 'starter' ? (
                    'Switch Plan'
                  ) : (
                    'Upgrade'
                  )}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>

        {/* Features Comparison */}
        <Card className="max-w-4xl mx-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500" />
              Why Upgrade?
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                { icon: Zap, title: 'Lower Fees', description: 'Keep more of what you earn with reduced platform fees' },
                { icon: Users, title: 'More Visibility', description: 'Get priority placement in search results' },
                { icon: BarChart3, title: 'Advanced Analytics', description: 'Track your performance with detailed insights' },
                { icon: Calendar, title: 'Flexible Scheduling', description: 'Advanced availability and booking controls' },
                { icon: MessageSquare, title: 'Priority Support', description: 'Get help faster when you need it' },
                { icon: Shield, title: 'Verified Badge', description: 'Build trust with a verified trainer badge' },
              ].map(({ icon: Icon, title, description }) => (
                <div key={title} className="flex items-start gap-3">
                  <div className="rounded-xl bg-brand-50 p-2">
                    <Icon className="h-5 w-5 text-brand-600" />
                  </div>
                  <div>
                    <h4 className="font-medium">{title}</h4>
                    <p className="text-sm text-muted-foreground">{description}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
