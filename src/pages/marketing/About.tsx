import { useParams } from 'react-router-dom';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { Target, Heart, Users, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MARKETING_DOMAIN, getAppUrl } from '@/lib/domains';
import { buildBreadcrumbList } from '@/lib/structuredData';
import {
  MarketingHero,
  MarketingSection,
  MarketingFinalCTA,
  IconTile,
} from '@/components/marketing/sections';

export default function About() {
  const { t } = useTranslation('marketing');
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang || 'en';

  const values = [
    { icon: Target, titleKey: 'about.values.quality.title', descriptionKey: 'about.values.quality.description' },
    { icon: Heart, titleKey: 'about.values.playerFocused.title', descriptionKey: 'about.values.playerFocused.description' },
    { icon: Users, titleKey: 'about.values.community.title', descriptionKey: 'about.values.community.description' },
    { icon: Zap, titleKey: 'about.values.simplicity.title', descriptionKey: 'about.values.simplicity.description' },
  ];

  const stats = [
    { value: '2026', labelKey: 'about.stats.founded' },
    { value: '500+', labelKey: 'about.stats.trainers' },
    { value: '50+', labelKey: 'about.stats.cities' },
  ];

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: t('about.hero.title'),
    description: t('about.hero.subtitle'),
    url: `${MARKETING_DOMAIN}/about`,
    mainEntity: {
      '@type': 'Organization',
      name: 'PadelTrainer.ai',
      description: t('about.hero.subtitle'),
      foundingDate: '2026',
      url: MARKETING_DOMAIN,
    },
  };

  const breadcrumbSchema = buildBreadcrumbList([
    { name: 'Home', url: `/${currentLang}` },
    { name: t('about.hero.title'), url: `/${currentLang}/about` },
  ]);

  return (
    <MarketingLayout>
      <SEO
        title={`${t('about.hero.title')} ${t('about.hero.titleHighlight')}`}
        description={t('about.hero.subtitle')}
        url="/about"
        structuredData={[structuredData, breadcrumbSchema]}
      />

      <MarketingHero
        eyebrow={t('about.hero.eyebrow', 'About')}
        title={
          <>
            {t('about.hero.title')}{' '}
            <span className="text-brand-500">{t('about.hero.titleHighlight')}</span>
          </>
        }
        subtitle={t('about.hero.subtitle')}
      />

      {/* Story */}
      <MarketingSection background="default" align="left" containerClassName="max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-[-0.02em] text-navy-900 mb-6">
            {t('about.story.title')}
          </h2>
          <div className="space-y-5 text-lg text-navy-700 leading-relaxed">
            <p>{t('about.story.p1')}</p>
            <p>{t('about.story.p2')}</p>
            <p>{t('about.story.p3')}</p>
          </div>
        </motion.div>
      </MarketingSection>

      {/* Values */}
      <MarketingSection
        background="cream"
        eyebrow={t('about.values.eyebrow', 'What we stand for')}
        heading={t('about.values.title')}
        subheading={t('about.values.subtitle')}
      >
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {values.map((value, index) => (
            <motion.div
              key={value.titleKey}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.08 }}
              className="card-chip p-6 text-center"
            >
              <IconTile icon={<value.icon className="h-6 w-6" />} className="mx-auto mb-4" />
              <h3 className="font-display text-lg font-bold text-navy-900 mb-2">
                {t(value.titleKey)}
              </h3>
              <p className="text-sm text-navy-600 leading-relaxed">{t(value.descriptionKey)}</p>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      {/* Stats */}
      <MarketingSection background="default" containerClassName="max-w-3xl">
        <div className="grid md:grid-cols-3 gap-8 text-center">
          {stats.map((stat, index) => (
            <motion.div
              key={stat.labelKey}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
            >
              <div className="font-display text-5xl md:text-6xl font-extrabold text-brand-500 tracking-[-0.02em] mb-2">
                {stat.value}
              </div>
              <div className="text-navy-600">{t(stat.labelKey)}</div>
            </motion.div>
          ))}
        </div>
      </MarketingSection>

      <MarketingFinalCTA
        title={t('about.cta.title')}
        body={t('about.cta.subtitle')}
        primaryHref={getAppUrl('/auth')}
        primaryLabel={t('about.cta.getStarted')}
        secondary={
          <a href="mailto:hello@padeltrainer.ai" className="pill-ghost text-base bg-white/10 text-white border-white/20 hover:bg-white/20">
            {t('about.cta.contact')}
          </a>
        }
      />
    </MarketingLayout>
  );
}
