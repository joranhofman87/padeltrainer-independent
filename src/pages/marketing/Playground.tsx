import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Target, AlertTriangle, BarChart3, Star, Dices } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { MARKETING_DOMAIN } from '@/lib/domains';

const tools = [
  {
    titleKey: 'playground.redFlagQuiz.title',
    descKey: 'playground.redFlagQuiz.desc',
    emoji: '🚩',
    to: '/playground/red-flag-quiz',
    colorClass: 'from-red-500/10 to-orange-500/10',
    icon: AlertTriangle,
  },
  {
    titleKey: 'playground.racketFinder.title',
    descKey: 'playground.racketFinder.desc',
    emoji: '🏸',
    to: '/playground/racket-finder',
    colorClass: 'from-blue-500/10 to-cyan-500/10',
    icon: Target,
  },
  {
    titleKey: 'playground.levelTest.title',
    descKey: 'playground.levelTest.desc',
    emoji: '📊',
    to: '/playground/level-test',
    colorClass: 'from-green-500/10 to-emerald-500/10',
    icon: BarChart3,
  },
  {
    titleKey: 'playground.rateMyCourt.title',
    descKey: 'playground.rateMyCourt.desc',
    emoji: '⭐',
    to: '/playground/rate-my-court',
    colorClass: 'from-yellow-500/10 to-amber-500/10',
    icon: Star,
  },
  {
    titleKey: 'playground.challengeMode.title',
    descKey: 'playground.challengeMode.desc',
    emoji: '🎲',
    to: '/playground/challenge-mode',
    colorClass: 'from-purple-500/10 to-violet-500/10',
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
        title={t('playground.seo.title', 'Padel Playground — Fun Quizzes & Tools | PadelTrainer.ai')}
        description={t('playground.seo.description', 'Take fun padel quizzes, find your perfect racket, and test your level. Interactive tools for padel players.')}
        url={`/${lang}/playground`}
        structuredData={[breadcrumb, itemList]}
      />
      <div className="container mx-auto px-4 py-16 md:py-24">
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-4">
            🎮 {t('playground.title', 'Padel Playground')}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {t('playground.subtitle', 'Fun quizzes, tools, and interactive experiences for padel lovers.')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {tools.map((tool) => (
            <LocalizedLink
              key={tool.to}
              to={tool.to}
              className="group block rounded-2xl border bg-card p-6 hover:shadow-lg transition-all duration-200 hover:-translate-y-1"
            >
              <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${tool.colorClass} flex items-center justify-center text-2xl mb-4`}>
                {tool.emoji}
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2 group-hover:text-primary transition-colors">
                {t(tool.titleKey)}
              </h2>
              <p className="text-muted-foreground text-sm mb-4">
                {t(tool.descKey)}
              </p>
              <Button variant="outline" size="sm" className="pointer-events-none">
                {t('playground.playNow', 'Play Now →')}
              </Button>
            </LocalizedLink>
          ))}
        </div>
      </div>
    </MarketingLayout>
  );
}
