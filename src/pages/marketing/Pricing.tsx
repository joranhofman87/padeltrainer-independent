import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Building2 } from 'lucide-react';

import { useTranslation } from 'react-i18next';
import { useTrainerPlans, useClubPlan } from '@/hooks/usePricingPlans';
import { Skeleton } from '@/components/ui/skeleton';
import { MARKETING_DOMAIN, getAppUrl } from '@/lib/domains';
import { trackEvent } from '@/lib/tracking';
import { buildBreadcrumbList, buildFaqPage } from '@/lib/structuredData';
import { useParams } from 'react-router-dom';
import {
  MarketingHero,
  MarketingSection,
  MarketingFinalCTA,
  MarketingFAQ,
  IconTile,
} from '@/components/marketing/sections';
import { cn } from '@/lib/utils';

export default function Pricing() {
  const { t } = useTranslation('marketing');
  const { data: trainerPlans, isLoading: loadingTrainer } = useTrainerPlans();
  const { data: clubPlan, isLoading: loadingClub } = useClubPlan();
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang || 'en';

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

  const getFeatureList = (tier: string): { title: string; description: string }[] => {
    const featureList = t(`pricing.trainers.plans.${tier}.featureList`, { returnObjects: true }) as unknown;
    return Array.isArray(featureList) ? featureList : [];
  };

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
          description: t('pricing.players.description'),
        },
        ...(trainerPlans?.map((plan, index) => ({
          '@type': 'Offer',
          name: plan.name,
          price: plan.monthly_price.toString(),
          priceCurrency: 'EUR',
          description: plan.description,
          position: index + 2,
        })) || []),
      ],
    },
  };

  const breadcrumbSchema = buildBreadcrumbList([
    { name: 'Home', url: `/${currentLang}` },
    { name: t('pricing.hero.title'), url: `/${currentLang}/pricing` },
  ]);

  const faqItems = faqKeys.map((key) => ({
    question: t(`pricing.faq.questions.${key}.q`),
    answer: t(`pricing.faq.questions.${key}.a`),
  }));

  const faqSchema = buildFaqPage(faqItems);

  return (
    <MarketingLayout>
      <SEO
        title={t('pricing.hero.title')}
        description={t('pricing.hero.subtitle')}
        url="/pricing"
        structuredData={[structuredData, breadcrumbSchema, faqSchema]}
      />

      {/* Hero */}
      <MarketingHero
        eyebrow={t('pricing.hero.eyebrow', 'Pricing')}
        title={t('pricing.hero.title')}
        subtitle={t('pricing.hero.subtitle')}
      />

      {/* Player tier */}
      <MarketingSection
        background="default"
        eyebrow={t('pricing.players.badge')}
        heading={t('pricing.players.title')}
        subheading={t('pricing.players.description')}
        containerClassName="max-w-3xl"
      >
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="card-chip p-6 md:p-8"
        >
          <div className="grid sm:grid-cols-2 gap-3">
            {playerFeatureKeys.map((featureKey) => (
              <div key={featureKey} className="flex items-center gap-2 text-navy-800">
                <Check className="h-5 w-5 text-brand-500 flex-shrink-0" />
                <span>{t(featureKey)}</span>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Link to={getAppUrl('/auth')} className="pill-primary text-base">
              {t('pricing.players.cta')}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </div>
        </motion.div>
      </MarketingSection>

      {/* Trainer tiers */}
      <MarketingSection
        background="cream"
        eyebrow={t('pricing.trainers.badge')}
        heading={t('pricing.trainers.title')}
        subheading={t('pricing.trainers.subtitle')}
      >
        {/* Billing toggle */}
        <div className="flex justify-center mb-10">
          <div className="inline-flex items-center gap-1 p-1 bg-card border border-navy-100 rounded-full shadow-soft">
            <button
              type="button"
              onClick={() => setBillingCycle('monthly')}
              className={cn(
                'px-4 py-2 text-sm font-medium rounded-full transition-colors',
                billingCycle === 'monthly'
                  ? 'bg-navy-900 text-white'
                  : 'text-navy-600 hover:text-navy-900',
              )}
            >
              {t('pricing.trainers.monthly')}
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle('yearly')}
              className={cn(
                'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full transition-colors',
                billingCycle === 'yearly'
                  ? 'bg-navy-900 text-white'
                  : 'text-navy-600 hover:text-navy-900',
              )}
            >
              {t('pricing.trainers.yearly')}
              <span className="rounded-full bg-success-soft text-success px-2 py-0.5 text-xs font-semibold">
                {t('pricing.trainers.save20')}
              </span>
            </button>
          </div>
        </div>

        {loadingTrainer ? (
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[500px] rounded-2xl" />
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
                  className={cn(
                    'card-chip p-6 md:p-8 relative h-full flex flex-col',
                    plan.is_highlighted && 'ring-2 ring-brand-500 shadow-cta',
                  )}
                >
                  {plan.is_highlighted && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 text-white px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                      {plan.badge || t('pricing.trainers.mostPopular')}
                    </span>
                  )}
                  <div className="text-center">
                    <h3 className="font-display text-xl font-bold text-navy-900">{plan.name}</h3>
                    <p className="mt-1 text-sm text-navy-600">
                      {t(`pricing.trainers.plans.${plan.tier}.description`)}
                    </p>
                    <div className="pt-5">
                      <span className="font-display text-5xl font-extrabold text-navy-900 tracking-[-0.02em]">
                        {plan.monthly_price === 0 && billingCycle === 'monthly'
                          ? t('pricing.trainers.plans.starter.price')
                          : `€${displayPrice}`}
                      </span>
                      <span className="text-navy-500 ml-1">
                        /{billingCycle === 'yearly' ? t('pricing.trainers.year') : t('pricing.trainers.month')}
                      </span>
                      {billingCycle === 'yearly' && yearlySavings > 0 && (
                        <p className="text-sm text-success font-semibold mt-1">
                          {t('pricing.trainers.saveAmount', { amount: yearlySavings })}
                        </p>
                      )}
                    </div>
                  </div>
                  <ul className="space-y-4 my-8 flex-1">
                    {getFeatureList(plan.tier).map((feature, fi) => (
                      <li key={fi} className="flex items-start gap-3">
                        <Check className="h-5 w-5 text-brand-500 flex-shrink-0 mt-0.5" />
                        <div>
                          <span className="font-semibold text-sm text-navy-900 block">{feature.title}</span>
                          <span className="text-xs text-navy-600">{feature.description}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={getAppUrl('/auth')}
                    onClick={() =>
                      trackEvent('pricing_plan_selected', { plan: plan.tier, billing_cycle: billingCycle })
                    }
                    className={cn(
                      'w-full justify-center',
                      plan.is_highlighted ? 'pill-primary' : 'pill-ghost',
                    )}
                  >
                    {t(`pricing.trainers.plans.${plan.tier}.cta`)}
                  </Link>
                </motion.div>
              );
            })}
          </div>
        )}
      </MarketingSection>

      {/* Club tier */}
      <MarketingSection
        background="default"
        eyebrow={t('pricing.clubs.badge')}
        heading={t('pricing.clubs.title')}
        subheading={t('pricing.clubs.subtitle')}
        containerClassName="max-w-3xl"
      >
        {loadingClub ? (
          <Skeleton className="h-[400px] rounded-2xl" />
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="card-chip p-6 md:p-10 relative ring-2 ring-brand-500 shadow-cta"
          >
            <span className="absolute top-0 right-0 bg-brand-500 text-white px-4 py-1 text-xs font-semibold uppercase tracking-wide rounded-bl-2xl rounded-tr-2xl">
              {t('pricing.clubs.trialBadge')}
            </span>
            <div className="text-center">
              <IconTile icon={<Building2 className="h-6 w-6" />} className="mx-auto mb-4" />
              <h3 className="font-display text-2xl font-bold text-navy-900">
                {clubPlan?.name || t('pricing.clubs.title')}
              </h3>
              <p className="mt-2 text-navy-600">
                {clubPlan?.description || t('pricing.clubs.subtitle')}
              </p>
              <div className="pt-5">
                <span className="font-display text-5xl font-extrabold text-navy-900 tracking-[-0.02em]">
                  €{clubPlan?.monthly_price || 199}
                </span>
                <span className="text-navy-500 ml-1">{t('pricing.clubs.period')}</span>
                <p className="text-sm text-navy-500 mt-1">{t('pricing.clubs.billedAnnually')}</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 my-8">
              {clubFeatureKeys.map((featureKey) => (
                <div key={featureKey} className="flex items-center gap-2 text-navy-800">
                  <Check className="h-5 w-5 text-brand-500 flex-shrink-0" />
                  <span>{t(featureKey)}</span>
                </div>
              ))}
            </div>
            <Link to={getAppUrl('/signup/club')} className="pill-primary w-full justify-center">
              {t('pricing.clubs.cta')}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </motion.div>
        )}
      </MarketingSection>

      {/* FAQ */}
      <MarketingFAQ
        eyebrow={t('pricing.faq.eyebrow', 'Questions')}
        heading={t('pricing.faq.title')}
        items={faqItems}
      />

      {/* Final CTA */}
      <MarketingFinalCTA
        eyebrow={t('homev2.finalCta.eyebrow', 'Ready when you are')}
        title={t('pricing.cta.title', t('homev2.finalCta.headline') as string)}
        body={t('pricing.cta.subtitle', t('homev2.finalCta.body') as string)}
        microcopy={t('homev2.dualCta.microcopy', '')}
      />
    </MarketingLayout>
  );
}
