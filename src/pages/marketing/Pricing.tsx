import { Link } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { Check, X, HelpCircle, Building2, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import { useTrainerPlans, useClubPlan } from '@/hooks/usePricingPlans';
import { Skeleton } from '@/components/ui/skeleton';
import { getAppUrl, isInDevelopment, MARKETING_DOMAIN } from '@/lib/domains';

export default function Pricing() {
  const { t } = useTranslation('marketing');
  const { data: trainerPlans, isLoading: loadingTrainer } = useTrainerPlans();
  const { data: clubPlan, isLoading: loadingClub } = useClubPlan();

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

  // Map tier to feature keys for translations
  const getFeatureList = (tier: string) => {
    const features = [
      { key: 'lessons', included: true },
      { key: 'profile', included: true },
      { key: 'bookings', included: true },
      { key: 'notifications', included: true },
      { key: 'calendar', included: tier !== 'starter' },
      { key: 'analytics', included: tier !== 'starter' },
      { key: 'support', included: tier !== 'starter' },
      { key: 'multiTrainer', included: tier === 'academy' },
    ];
    return features;
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
                    {isInDevelopment() ? (
                      <Link to="/auth">{t('pricing.players.cta')}</Link>
                    ) : (
                      <a href={getAppUrl('/auth')}>{t('pricing.players.cta')}</a>
                    )}
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
            <Badge variant="secondary" className="mb-4">{t('pricing.trainers.badge')}</Badge>
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('pricing.trainers.title')}
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('pricing.trainers.subtitle')}
            </p>
          </motion.div>

          {loadingTrainer ? (
            <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[500px] rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
              {trainerPlans?.map((plan, index) => (
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
                      <CardDescription>{plan.description}</CardDescription>
                      <div className="pt-4">
                        <span className="text-4xl font-bold">
                          {plan.monthly_price === 0 ? t('pricing.trainers.plans.starter.price') : `€${plan.monthly_price}`}
                        </span>
                        {plan.monthly_price > 0 && (
                          <span className="text-muted-foreground">/month</span>
                        )}
                        {plan.yearly_price > 0 && (
                          <p className="text-sm text-muted-foreground mt-1">
                            €{plan.yearly_price}/year (save {Math.round((1 - plan.yearly_price / (plan.monthly_price * 12)) * 100)}%)
                          </p>
                        )}
                      </div>
                      <div className="pt-2 flex items-center justify-center gap-1">
                        <Badge variant="outline">€{plan.platform_fee_flat?.toFixed(2) ?? '1.00'} {t('pricing.trainers.platformFee')}</Badge>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{t('pricing.trainers.feeTooltip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-3 mb-8">
                        {getFeatureList(plan.tier).map((feature) => (
                          <li key={feature.key} className="flex items-center gap-2">
                            {feature.included ? (
                              <Check className="h-5 w-5 text-primary flex-shrink-0" />
                            ) : (
                              <X className="h-5 w-5 text-muted-foreground/50 flex-shrink-0" />
                            )}
                            <span className={feature.included ? '' : 'text-muted-foreground/50'}>
                              {t(`pricing.trainers.plans.${plan.tier}.features.${feature.key}`)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <Button 
                        className="w-full" 
                        variant={plan.is_highlighted ? 'default' : 'outline'}
                        asChild
                      >
                        {isInDevelopment() ? (
                          <Link to="/auth">{t(`pricing.trainers.plans.${plan.tier}.cta`)}</Link>
                        ) : (
                          <a href={getAppUrl('/auth')}>{t(`pricing.trainers.plans.${plan.tier}.cta`)}</a>
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
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
                    {isInDevelopment() ? (
                      <Link to="/signup/club">{t('pricing.clubs.cta')}</Link>
                    ) : (
                      <a href={getAppUrl('/signup/club')}>{t('pricing.clubs.cta')}</a>
                    )}
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
