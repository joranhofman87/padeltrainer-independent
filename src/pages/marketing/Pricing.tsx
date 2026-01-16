import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Check, X, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export default function Pricing() {
  const playerFeatures = [
    'Browse all verified trainers',
    'Read reviews and ratings',
    'Book lessons online',
    'Secure iDEAL & card payments',
    'Google Calendar sync',
    'Email notifications',
    'Track your bookings',
  ];

  const trainerPlans = [
    {
      name: 'Starter',
      price: 'Free',
      period: '',
      description: 'Perfect for getting started',
      platformFee: '10%',
      features: [
        { text: 'Up to 3 active lessons', included: true },
        { text: 'Basic profile page', included: true },
        { text: 'Accept online bookings', included: true },
        { text: 'Email notifications', included: true },
        { text: 'Calendar sync', included: false },
        { text: 'Analytics dashboard', included: false },
        { text: 'Priority support', included: false },
        { text: 'Multi-trainer support', included: false },
      ],
      cta: 'Start Free',
      popular: false,
    },
    {
      name: 'Professional',
      price: '€29',
      period: '/month',
      yearlyPrice: '€278/year (save 20%)',
      description: 'For serious trainers',
      platformFee: '5%',
      features: [
        { text: 'Unlimited active lessons', included: true },
        { text: 'Enhanced profile page', included: true },
        { text: 'Accept online bookings', included: true },
        { text: 'Email notifications', included: true },
        { text: 'Google Calendar sync', included: true },
        { text: 'Analytics dashboard', included: true },
        { text: 'Priority support', included: true },
        { text: 'Multi-trainer support', included: false },
      ],
      cta: 'Get Professional',
      popular: true,
    },
    {
      name: 'Academy',
      price: '€79',
      period: '/month',
      yearlyPrice: '€758/year (save 20%)',
      description: 'For clubs & academies',
      platformFee: '2.5%',
      features: [
        { text: 'Unlimited active lessons', included: true },
        { text: 'Premium profile page', included: true },
        { text: 'Accept online bookings', included: true },
        { text: 'Email notifications', included: true },
        { text: 'Google Calendar sync', included: true },
        { text: 'Advanced analytics', included: true },
        { text: 'Dedicated support', included: true },
        { text: 'Multi-trainer support', included: true },
      ],
      cta: 'Contact Sales',
      popular: false,
    },
  ];

  return (
    <MarketingLayout>
      {/* Hero */}
      <section className="py-20 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-3xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              Simple, transparent pricing
            </h1>
            <p className="text-xl text-muted-foreground">
              Free for players. Flexible plans for trainers to grow their business.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Player Pricing */}
      <section className="py-16">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="max-w-2xl mx-auto"
          >
            <Card className="border-2 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
              <CardHeader className="text-center pb-4">
                <Badge className="w-fit mx-auto mb-2">For Players</Badge>
                <CardTitle className="text-2xl">Always Free</CardTitle>
                <CardDescription className="text-lg">
                  No subscription fees. Just pay for the lessons you book.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid sm:grid-cols-2 gap-3">
                  {playerFeatures.map((feature) => (
                    <div key={feature} className="flex items-center gap-2">
                      <Check className="h-5 w-5 text-primary flex-shrink-0" />
                      <span>{feature}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-8 text-center">
                  <Button size="lg" className="px-8" asChild>
                    <Link to="/auth">Get Started Free</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* Trainer Pricing */}
      <section className="py-16 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center mb-12"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <Badge variant="secondary" className="mb-4">For Trainers</Badge>
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Choose your plan
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Start free and upgrade as your business grows. Lower platform fees with higher tiers.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {trainerPlans.map((plan, index) => (
              <motion.div
                key={plan.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className={`h-full relative ${plan.popular ? 'border-2 border-primary shadow-lg' : ''}`}>
                  {plan.popular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">
                      Most Popular
                    </Badge>
                  )}
                  <CardHeader className="text-center">
                    <CardTitle className="text-xl">{plan.name}</CardTitle>
                    <CardDescription>{plan.description}</CardDescription>
                    <div className="pt-4">
                      <span className="text-4xl font-bold">{plan.price}</span>
                      <span className="text-muted-foreground">{plan.period}</span>
                      {plan.yearlyPrice && (
                        <p className="text-sm text-muted-foreground mt-1">{plan.yearlyPrice}</p>
                      )}
                    </div>
                    <div className="pt-2 flex items-center justify-center gap-1">
                      <Badge variant="outline">{plan.platformFee} platform fee</Badge>
                      <Tooltip>
                        <TooltipTrigger>
                          <HelpCircle className="h-4 w-4 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Fee deducted from each lesson payment</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-3 mb-8">
                      {plan.features.map((feature) => (
                        <li key={feature.text} className="flex items-center gap-2">
                          {feature.included ? (
                            <Check className="h-5 w-5 text-primary flex-shrink-0" />
                          ) : (
                            <X className="h-5 w-5 text-muted-foreground/50 flex-shrink-0" />
                          )}
                          <span className={feature.included ? '' : 'text-muted-foreground/50'}>
                            {feature.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <Button 
                      className="w-full" 
                      variant={plan.popular ? 'default' : 'outline'}
                      asChild
                    >
                      <Link to="/auth">{plan.cta}</Link>
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center mb-12"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl font-bold mb-4">Frequently asked questions</h2>
          </motion.div>

          <div className="max-w-3xl mx-auto space-y-6">
            {[
              {
                q: 'How does the platform fee work?',
                a: 'The platform fee is automatically deducted from each lesson payment. For example, if you charge €50 for a lesson on the Professional plan (5% fee), you receive €47.50.'
              },
              {
                q: 'Can I change plans later?',
                a: 'Yes! You can upgrade or downgrade your plan at any time. When upgrading, you get immediate access to new features. When downgrading, changes take effect at the end of your billing cycle.'
              },
              {
                q: 'Is there a contract or commitment?',
                a: 'No long-term contracts. All plans are billed monthly or yearly, and you can cancel anytime. Yearly plans offer 20% savings.'
              },
              {
                q: 'How do payouts work?',
                a: 'Payments are processed through Stripe Connect. After a lesson is completed, funds are transferred to your connected bank account, typically within 2-3 business days.'
              }
            ].map((faq, index) => (
              <motion.div
                key={faq.q}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-2">{faq.q}</h3>
                    <p className="text-muted-foreground">{faq.a}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
