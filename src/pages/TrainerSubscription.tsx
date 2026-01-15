import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
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
  Sparkles
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface PricingPlan {
  id: string;
  name: string;
  price: number;
  period: string;
  description: string;
  features: string[];
  highlighted?: boolean;
  badge?: string;
}

const pricingPlans: PricingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: 0,
    period: 'month',
    description: 'Perfect for getting started',
    features: [
      'Create up to 3 lessons',
      'Basic profile page',
      'Accept bookings',
      '10% platform fee',
    ],
  },
  {
    id: 'professional',
    name: 'Professional',
    price: 29,
    period: 'month',
    description: 'Everything you need to grow',
    features: [
      'Unlimited lessons',
      'Priority in search results',
      'Advanced analytics',
      'Custom availability',
      '5% platform fee',
      'Priority support',
    ],
    highlighted: true,
    badge: 'Most Popular',
  },
  {
    id: 'academy',
    name: 'Academy',
    price: 79,
    period: 'month',
    description: 'For clubs and academies',
    features: [
      'Everything in Professional',
      'Multiple trainer accounts',
      'Group management',
      'Branded booking page',
      '2.5% platform fee',
      'Dedicated account manager',
      'API access',
    ],
    badge: 'Best Value',
  },
];

export default function TrainerSubscription() {
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const { toast } = useToast();
  const [currentPlan, setCurrentPlan] = useState('starter');
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const handleSelectPlan = (planId: string) => {
    toast({
      title: 'Subscription UI Ready',
      description: 'Stripe integration required to process subscriptions',
    });
    setCurrentPlan(planId);
  };

  const getYearlyPrice = (monthlyPrice: number) => {
    return Math.round(monthlyPrice * 12 * 0.8); // 20% discount for yearly
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
                      : 'Your next billing date is January 15, 2025'
                    }
                  </p>
                </div>
              </div>
              {currentPlan !== 'starter' && (
                <Button variant="outline" size="sm">Manage Billing</Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Billing Toggle */}
        <div className="flex justify-center mb-8">
          <div className="inline-flex items-center gap-4 p-1 bg-muted rounded-lg">
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
              <Badge variant="secondary" className="bg-green-100 text-green-700 text-xs">
                Save 20%
              </Badge>
            </Button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto mb-12">
          {pricingPlans.map((plan) => (
            <Card 
              key={plan.id}
              className={`relative ${plan.highlighted ? 'border-primary shadow-lg scale-105' : ''} ${currentPlan === plan.id ? 'ring-2 ring-primary' : ''}`}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className={plan.highlighted ? 'bg-primary' : 'bg-orange-500'}>
                    <Sparkles className="h-3 w-3 mr-1" />
                    {plan.badge}
                  </Badge>
                </div>
              )}
              <CardHeader className="text-center pt-8">
                <CardTitle className="text-2xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
                <div className="pt-4">
                  <span className="text-4xl font-bold">
                    €{billingCycle === 'yearly' ? getYearlyPrice(plan.price) : plan.price}
                  </span>
                  <span className="text-muted-foreground">
                    /{billingCycle === 'yearly' ? 'year' : 'month'}
                  </span>
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
                </ul>
              </CardContent>
              <CardFooter>
                <Button 
                  className="w-full" 
                  variant={plan.highlighted ? 'default' : 'outline'}
                  disabled={currentPlan === plan.id}
                  onClick={() => handleSelectPlan(plan.id)}
                >
                  {currentPlan === plan.id ? 'Current Plan' : plan.price === 0 ? 'Get Started' : 'Upgrade'}
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