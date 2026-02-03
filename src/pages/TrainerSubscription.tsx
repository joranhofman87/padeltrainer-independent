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
import { supabase } from '@/integrations/supabase/client';
import { useTrainerPlans, SubscriptionPlan } from '@/hooks/usePricingPlans';
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary';
import { logger } from '@/lib/logger';

export default function TrainerSubscription() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, role, loading, subscription, refreshSubscription, session } = useAuth();
  const { toast } = useToast();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);
  const [loadingPortal, setLoadingPortal] = useState(false);
  
  const { data: plans, isLoading: loadingPlans } = useTrainerPlans();

  // Handle success/cancel from Mollie checkout
  useEffect(() => {
    const success = searchParams.get('success');
    const canceled = searchParams.get('canceled');

    if (success === 'true') {
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
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  if (loading || loadingPlans) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10" />
              <Skeleton className="h-8 w-48" />
            </div>
          </div>
        </header>
        <main className="container mx-auto px-4 py-8">
          <Skeleton className="h-24 mb-8" />
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[400px]" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  const currentPlan = subscription?.tier || 'starter';

  const handleSelectPlan = async (plan: SubscriptionPlan) => {
    if (plan.tier === 'starter') {
      toast({
        title: 'Use Cancel Subscription',
        description: 'To downgrade, please cancel your current subscription.',
      });
      return;
    }

    const planId = billingCycle === 'monthly' ? plan.tier : `${plan.tier}_yearly`;

    setProcessingPlan(plan.id);

    try {
      logger.info('Starting Mollie checkout for subscription', { 
        component: 'TrainerSubscription', 
        planId, 
        billingCycle 
      });

      const { data, error } = await supabase.functions.invoke('create-mollie-subscription', {
        body: { planId },
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (error) throw error;

      if (data?.hasActiveSubscription) {
        toast({
          title: 'Already Subscribed',
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
        planId 
      });
      toast({
        title: 'Error',
        description: 'Failed to start checkout. Please try again.',
        variant: 'destructive',
      });
      setProcessingPlan(null);
    }
  };

  const handleCancelSubscription = async () => {
    setLoadingPortal(true);

    try {
      const { data, error } = await supabase.functions.invoke('cancel-mollie-subscription', {
        body: { type: 'trainer' },
        headers: {
          Authorization: `Bearer ${session?.access_token}`,
        },
      });

      if (error) throw error;

      toast({
        title: 'Subscription Canceled',
        description: data.message || 'Your subscription has been canceled.',
      });
      
      refreshSubscription();
    } catch (err) {
      logger.error('Subscription cancellation failed', err as Error, { 
        component: 'TrainerSubscription' 
      });
      toast({
        title: 'Error',
        description: 'Failed to cancel subscription. Please try again.',
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
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-2xl">👑</span>
              <span className="font-bold text-xl">Subscription Plans</span>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Current Plan Banner */}
        <Card className="mb-8 border-primary/20 bg-gradient-to-r from-primary/5 to-primary/10">
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
                  onClick={handleCancelSubscription}
                  disabled={loadingPortal}
                >
                  {loadingPortal ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  Cancel Subscription
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
              <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 text-xs">
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
              className={`relative ${plan.is_highlighted ? 'border-primary shadow-lg scale-105' : ''} ${currentPlan === plan.tier ? 'ring-2 ring-primary' : ''}`}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className={plan.is_highlighted ? 'bg-primary' : 'bg-orange-500'}>
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
                    <p className="text-sm text-green-600 dark:text-green-400 font-medium mt-1">
                      Save €{Math.round(plan.monthly_price * 12 - plan.yearly_price)}/year
                    </p>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Separator />
                <ul className="space-y-3">
                  {plan.features.map((feature, index) => (
                    <li key={index} className="flex items-start gap-2">
                      <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                  <li className="flex items-start gap-2">
                    <Check className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                    <span className="text-sm">{plan.platform_fee_percent}% platform fee</span>
                  </li>
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
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900">
                  <Zap className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h4 className="font-medium">Lower Fees</h4>
                  <p className="text-sm text-muted-foreground">Keep more of what you earn with reduced platform fees</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900">
                  <Users className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <h4 className="font-medium">More Visibility</h4>
                  <p className="text-sm text-muted-foreground">Get priority placement in search results</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900">
                  <BarChart3 className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <h4 className="font-medium">Advanced Analytics</h4>
                  <p className="text-sm text-muted-foreground">Track your performance with detailed insights</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-orange-100 dark:bg-orange-900">
                  <Calendar className="h-5 w-5 text-orange-600" />
                </div>
                <div>
                  <h4 className="font-medium">Flexible Scheduling</h4>
                  <p className="text-sm text-muted-foreground">Advanced availability and booking controls</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-pink-100 dark:bg-pink-900">
                  <MessageSquare className="h-5 w-5 text-pink-600" />
                </div>
                <div>
                  <h4 className="font-medium">Priority Support</h4>
                  <p className="text-sm text-muted-foreground">Get help faster when you need it</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-cyan-100 dark:bg-cyan-900">
                  <Shield className="h-5 w-5 text-cyan-600" />
                </div>
                <div>
                  <h4 className="font-medium">Verified Badge</h4>
                  <p className="text-sm text-muted-foreground">Build trust with a verified trainer badge</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
