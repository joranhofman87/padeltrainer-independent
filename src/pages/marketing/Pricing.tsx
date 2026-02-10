import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { Check, Building2 } from 'lucide-react';

import { useTranslation } from 'react-i18next';
import { useTrainerPlans, useClubPlan } from '@/hooks/usePricingPlans';
import { Skeleton } from '@/components/ui/skeleton';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { trackEvent } from '@/lib/tracking';

export default function Pricing() {
  const { t } = useTranslation('marketing');
  const { data: trainerPlans, isLoading: loadingTrainer } = useTrainerPlans();
  const { data: clubPlan, isLoading: loadingClub } = useClubPlan();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

  useEffect(() => {
    trackEvent('pricing_page_viewed');
  }, []);

  const playerFeatureKeys = [
    'pricing.players.features.browse',
    'pricing.players.features.reviews',
    'pricing.players.features.book',
    'pricing.players.features.payments',
    'pricing.players.features.calendar',
    'pricing.players.features.notifications',
    'pricing.players.features.tracking',
  ];

  const clubFeatureKeys = [
    'pricing.clubs.features.trainers',
    'pricing.clubs.features.calendar',
    'pricing.clubs.features.players',
    'pricing.clubs.features.bookings',
    'pricing.clubs.features.analytics',
    'pricing.clubs.features.profile',
    'pricing.clubs.features.support',
    'pricing.clubs.features.branding',
  ];

  const faqKeys = ['platformFee', 'changePlans', 'contract', 'payouts', 'clubTrial'];

  // Get feature list with title + description from translations
  const getFeatureList = (tier: string): { title: string; description: string }[] => {
    const featureList = t(`pricing.trainers.plans.${tier}.featureList`, { returnObjects: true }) as unknown;
    return Array.isArray(featureList) ? featureList : [];
  };

  // Structured data for pricing page
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: t('pricing.hero.title'),
    description: t('pricing.hero.subtitle'),
    url: `${MARKETING_DOMAIN}/pricing`,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: [
        {
          '@type': 'Offer',
          name: 'Player',
          price: '0',
          priceCurrency: 'EUR',
          description: t('pricing.players.description')
        },
        ...(trainerPlans?.map((plan, index) => ({
          '@type': 'Offer',
          name: plan.name,
          price: plan.monthly_price.toString(),
          priceCurrency: 'EUR',
          description: plan.description,
          position: index + 2
        })) || [])
      ]
    }
  };

  return (
    <MarketingLayout>
      <SEO 
        title={t('pricing.hero.title')}
        description={t('pricing.hero.subtitle')}
        url="/pricing"
        structuredData={structuredData}
      />
      {/* Hero */}
      <section className="py-20 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-3xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-4">
              {t('pricing.hero.title')}
            </h1>
            <p className="text-xl text-muted-foreground">
              {t('pricing.hero.subtitle')}
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
                <Badge className="w-fit mx-auto mb-2">{t('pricing.players.badge')}</Badge>
                <CardTitle className="text-2xl">{t('pricing.players.title')}</CardTitle>
                <CardDescription className="text-lg">
                  {t('pricing.players.description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid sm:grid-cols-2 gap-3">
                  {playerFeatureKeys.map((featureKey) => (
                    <div key={featureKey} className="flex items-center gap-2">
                      <Check className="h-5 w-5 text-primary flex-shrink-0" />
                      <span>{t(featureKey)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-8 text-center">
                  <Button size="lg" className="px-8" asChild>
                    <Link to="/app/auth">{t('pricing.players.cta')}</Link>
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
            className="text-center mb-8"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <Badge variant="secondary" className="mb-4">{t('pricing.trainers.badge')}</Badge>
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('pricing.trainers.title')}
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('pricing.trainers.subtitle')}
            </p>
          </motion.div>

          {/* Billing Toggle */}
          <div className="flex justify-center mb-8">
            <div className="inline-flex items-center gap-1 p-1 bg-muted rounded-lg">
              <Button
                variant={billingCycle === 'monthly' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setBillingCycle('monthly')}
              >
                {t('pricing.trainers.monthly')}
              </Button>
              <Button
                variant={billingCycle === 'yearly' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setBillingCycle('yearly')}
                className="gap-2"
              >
                {t('pricing.trainers.yearly')}
                <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                  {t('pricing.trainers.save20')}
                </Badge>
              </Button>
            </div>
          </div>

          {loadingTrainer ? (
            <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[500px] rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
              {trainerPlans?.map((plan, index) => {
                const displayPrice = billingCycle === 'yearly' ? plan.yearly_price : plan.monthly_price;
                const yearlySavings = plan.monthly_price > 0 
                  ? Math.round(plan.monthly_price * 12 - plan.yearly_price) 
                  : 0;
                
                return (
                  <motion.div
                    key={plan.id}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.1 }}
                  >
                    <Card className={`h-full relative ${plan.is_highlighted ? 'border-2 border-primary shadow-lg' : ''}`}>
                      {plan.is_highlighted && (
                        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">
                          {plan.badge || t('pricing.trainers.mostPopular')}
                        </Badge>
                      )}
                      <CardHeader className="text-center">
                        <CardTitle className="text-xl">{plan.name}</CardTitle>
                        <CardDescription>{t(`pricing.trainers.plans.${plan.tier}.description`)}</CardDescription>
                        <div className="pt-4">
                          <span className="text-4xl font-bold">
                            {plan.monthly_price === 0 && billingCycle === 'monthly' 
                              ? t('pricing.trainers.plans.starter.price') 
                              : `€${displayPrice}`}
                          </span>
                          <span className="text-muted-foreground">
                            /{billingCycle === 'yearly' ? t('pricing.trainers.year') : t('pricing.trainers.month')}
                          </span>
                          {billingCycle === 'yearly' && yearlySavings > 0 && (
                            <p className="text-sm text-green-600 dark:text-green-400 font-medium mt-1">
                              {t('pricing.trainers.saveAmount', { amount: yearlySavings })}
                            </p>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-4 mb-8">
                          {getFeatureList(plan.tier).map((feature, fi) => (
                            <li key={fi} className="flex items-start gap-3">
                              <Check className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                              <div>
                                <span className="font-semibold text-sm block">{feature.title}</span>
                                <span className="text-xs text-muted-foreground">{feature.description}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <Button 
                          className="w-full" 
                          variant={plan.is_highlighted ? 'default' : 'outline'}
                          asChild
                        >
                          <Link to="/app/auth">{t(`pricing.trainers.plans.${plan.tier}.cta`)}</Link>
                        </Button>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Club Pricing */}
      <section className="py-16">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center mb-12"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <Badge variant="secondary" className="mb-4">{t('pricing.clubs.badge')}</Badge>
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('pricing.clubs.title')}
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('pricing.clubs.subtitle')}
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="max-w-2xl mx-auto"
          >
            {loadingClub ? (
              <Skeleton className="h-[400px] rounded-lg" />
            ) : (
              <Card className="border-2 border-primary shadow-lg relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-primary text-primary-foreground px-4 py-1 text-sm font-medium rounded-bl-lg">
                  {t('pricing.clubs.trialBadge')}
                </div>
                <CardHeader className="text-center pb-4 pt-8">
                  <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                    <Building2 className="h-6 w-6 text-primary" />
                  </div>
                  <CardTitle className="text-2xl">{clubPlan?.name || t('pricing.clubs.title')}</CardTitle>
                  <CardDescription className="text-lg">
                    {clubPlan?.description || t('pricing.clubs.subtitle')}
                  </CardDescription>
                  <div className="pt-4">
                    <span className="text-4xl font-bold">€{clubPlan?.monthly_price || 199}</span>
                    <span className="text-muted-foreground">{t('pricing.clubs.period')}</span>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('pricing.clubs.billedAnnually')}
                    </p>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid sm:grid-cols-2 gap-3 mb-8">
                    {clubFeatureKeys.map((featureKey) => (
                      <div key={featureKey} className="flex items-center gap-2">
                        <Check className="h-5 w-5 text-primary flex-shrink-0" />
                        <span>{t(featureKey)}</span>
                      </div>
                    ))}
                  </div>
                  <Button size="lg" className="w-full" asChild>
                    <Link to="/app/signup/club">{t('pricing.clubs.cta')}</Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </motion.div>
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
            <h2 className="text-3xl font-bold mb-4">{t('pricing.faq.title')}</h2>
          </motion.div>

          <div className="max-w-3xl mx-auto space-y-6">
            {faqKeys.map((faqKey, index) => (
              <motion.div
                key={faqKey}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card>
                  <CardContent className="p-6">
                    <h3 className="font-semibold mb-2">{t(`pricing.faq.questions.${faqKey}.q`)}</h3>
                    <p className="text-muted-foreground">{t(`pricing.faq.questions.${faqKey}.a`)}</p>
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
