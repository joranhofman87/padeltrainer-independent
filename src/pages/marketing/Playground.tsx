import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Target, AlertTriangle, BarChart3, Star, Dices, ArrowRight } from 'lucide-react';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { MarketingHero, MarketingSection, IconTile } from '@/components/marketing/sections';

const tools = [
  {
    titleKey: 'playground.redFlagQuiz.title',
    descKey: 'playground.redFlagQuiz.desc',
    to: '/playground/red-flag-quiz',
    icon: AlertTriangle,
  },
  {
    titleKey: 'playground.racketFinder.title',
    descKey: 'playground.racketFinder.desc',
    to: '/playground/racket-finder',
    icon: Target,
  },
  {
    titleKey: 'playground.levelTest.title',
    descKey: 'playground.levelTest.desc',
    to: '/playground/level-test',
    icon: BarChart3,
  },
  {
    titleKey: 'playground.rateMyCourt.title',
    descKey: 'playground.rateMyCourt.desc',
    to: '/playground/rate-my-court',
    icon: Star,
  },
  {
    titleKey: 'playground.challengeMode.title',
    descKey: 'playground.challengeMode.desc',
    to: '/playground/challenge-mode',
    icon: Dices,
  },
];

export default function Playground() {
  const { t } = useTranslation('marketing');
  const { lang = 'en' } = useParams<{ lang: string }>();

  const breadcrumb = buildBreadcrumbList([
    { name: t('nav.home', 'Home'), url: `${MARKETING_DOMAIN}/${lang}` },
    { name: t('playground.title', 'Padel Playground') },
  ]);

  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: t('playground.title', 'Padel Playground'),
    itemListElement: tools.map((tool, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t(tool.titleKey),
      url: `${MARKETING_DOMAIN}/${lang}${tool.to}`,
    })),
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('playground.seo.title', 'Padel Playground - Fun Quizzes & Tools | PadelTrainer.ai')}
        description={t('playground.seo.description', 'Take fun padel quizzes, find your perfect racket, and test your level. Interactive tools for padel players.')}
        url={`/${lang}/playground`}
        structuredData={[breadcrumb, itemList]}
      />

      <MarketingHero
        eyebrow={t('playground.eyebrow', 'Interactive tools')}
        title={t('playground.title', 'Padel Playground')}
        subtitle={t('playground.subtitle', 'Fun quizzes, tools, and interactive experiences for padel lovers.')}
      />

      <MarketingSection background="default">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {tools.map((tool, index) => {
            const Icon = tool.icon;
            return (
              <LocalizedLink
                key={tool.to}
                to={tool.to}
                className="group block card-chip p-6 transition-all hover:-translate-y-0.5 hover:shadow-mock"
              >
                <IconTile icon={<Icon className="h-6 w-6" />} size="lg" className="mb-4" />
                <h2 className="font-display text-xl font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors">
                  {t(tool.titleKey)}
                </h2>
                <p className="text-navy-600 text-sm mb-4 leading-relaxed">{t(tool.descKey)}</p>
                <span className="inline-flex items-center text-sm font-semibold text-brand-600">
                  {t('playground.playNow', 'Play now')}
                  <ArrowRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </LocalizedLink>
            );
          })}
        </div>
      </MarketingSection>
    </MarketingLayout>
  );
}
