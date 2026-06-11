import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLearningArticles, CONTENT_TYPE_LABELS, SKILL_LEVEL_LABELS } from '@/lib/learningArticles';
import type { LearningArticleSummary } from '@/lib/learningArticles';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { MarketingHero, MarketingSection, IconTile } from '@/components/marketing/sections';
import { cn } from '@/lib/utils';

const CONTENT_TYPE_KEYS = Object.keys(CONTENT_TYPE_LABELS);

function IndexSkeleton() {
  return (
    <div className="grid md:grid-cols-2 gap-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-40 w-full rounded-2xl" />
      ))}
    </div>
  );
}

export default function LearnIndex() {
  const { t, i18n } = useTranslation('marketing');
  const currentLang = i18n.language || 'en';
  const [searchParams] = useSearchParams();

  const activeType = searchParams.get('type');
  const activeTopic = searchParams.get('topic');

  const lang = i18n?.language || 'en';

  const { data: articles = [], isLoading } = useQuery({
    queryKey: ['learning-articles', lang],
    queryFn: () => getLearningArticles(lang),
    staleTime: 1000 * 60 * 10,
  });

  let filtered = articles;
  if (activeTopic) {
    filtered = filtered.filter((a) => a.topics?.some((tp) => tp.slug === activeTopic));
  }
  if (activeType) {
    filtered = filtered.filter((a) => a.contentType === activeType);
  }

  const hubs = filtered.filter((a) => a.pageType === 'hub');
  const children = filtered.filter((a) => a.pageType === 'child');

  const childrenByType = children.reduce<Record<string, LearningArticleSummary[]>>((acc, a) => {
    const key = a.contentType || 'other';
    if (!acc[key]) acc[key] = [];
    acc[key].push(a);
    return acc;
  }, {});

  const collectionPageSchema = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: t('learn.seoTitle', 'Learn Padel - Guides, Tactics & Drills'),
    description: t('learn.seoDescription', 'Guides, tactics, drills, and everything you need to improve your padel game.'),
    url: `${MARKETING_DOMAIN}/${currentLang}/learn`,
    publisher: { '@type': 'Organization', name: 'PadelTrainer.ai' },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: articles.slice(0, 50).map((article, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: `${MARKETING_DOMAIN}/${currentLang}/learn/${article.slug}`,
        name: article.h1,
      })),
    },
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${MARKETING_DOMAIN}/${currentLang}` },
      { '@type': 'ListItem', position: 2, name: t('learn.title', 'Learn Padel'), item: `${MARKETING_DOMAIN}/${currentLang}/learn` },
    ],
  };

  const structuredData = [collectionPageSchema, breadcrumbSchema];

  const activeTopicTitle = activeTopic
    ? articles.find((a) => a.topics?.some((tp) => tp.slug === activeTopic))
        ?.topics?.find((tp) => tp.slug === activeTopic)?.title
    : null;

  return (
    <MarketingLayout>
      <SEO
        title={t('learn.seoTitle', 'Learn Padel - Guides, Tactics & Drills')}
        description={t('learn.seoDescription', 'Guides, tactics, drills, and everything you need to improve your padel game. From beginner to advanced.')}
        url="/learn"
        type="website"
        structuredData={structuredData}
      />

      <MarketingHero
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <BookOpen className="h-3.5 w-3.5" />
            {t('learn.eyebrow', 'Learn padel')}
          </span>
        }
        title={t('learn.title', 'Learn Padel')}
        subtitle={t('learn.subtitle', 'Guides, tactics, drills, and everything you need to improve your padel game.')}
        compact
      />

      <MarketingSection background="default" align="left" containerClassName="max-w-5xl">
        {/* Filter chips */}
        <nav className="flex flex-wrap gap-2 mb-10" aria-label="Filter by content type">
          <LocalizedLink
            to="/learn"
            className={cn(
              'rounded-full px-3 py-1 text-sm font-semibold transition-colors',
              !activeType && !activeTopic
                ? 'bg-navy-900 text-white'
                : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
            )}
          >
            {t('learn.filterAll', 'All')}
          </LocalizedLink>
          {CONTENT_TYPE_KEYS.map((key) => (
            <LocalizedLink
              key={key}
              to={`/learn?type=${key}`}
              className={cn(
                'rounded-full px-3 py-1 text-sm font-semibold transition-colors',
                activeType === key
                  ? 'bg-navy-900 text-white'
                  : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
              )}
            >
              {CONTENT_TYPE_LABELS[key]}
            </LocalizedLink>
          ))}
        </nav>

        {activeTopicTitle && (
          <div className="mb-6 flex items-center gap-2">
            <span className="text-sm text-navy-600">{t('learn.filteringByTopic', 'Filtering by topic:')}</span>
            <span className="rounded-full bg-brand-50 text-brand-700 px-2.5 py-1 text-xs font-semibold">
              {activeTopicTitle}
            </span>
            <LocalizedLink to="/learn" className="text-xs text-brand-600 hover:underline ml-2">
              {t('learn.clearFilter', 'Clear')}
            </LocalizedLink>
          </div>
        )}

        {isLoading ? (
          <IndexSkeleton />
        ) : (
          <>
            {hubs.length > 0 && (
              <section className="mb-14">
                <h2 className="font-display text-2xl md:text-3xl font-extrabold tracking-[-0.02em] text-navy-900 mb-6">
                  {t('learn.guides', 'Guides')}
                </h2>
                <div className="grid md:grid-cols-2 gap-6">
                  {hubs.map((hub) => (
                    <ArticleCard key={hub._id} article={hub} hub />
                  ))}
                </div>
              </section>
            )}

            {activeType || activeTopic ? (
              children.length > 0 && (
                <section>
                  <h2 className="font-display text-2xl md:text-3xl font-extrabold tracking-[-0.02em] text-navy-900 mb-6">
                    {activeType
                      ? CONTENT_TYPE_LABELS[activeType] || activeType
                      : t('learn.allArticles', 'All Articles')}
                  </h2>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {children.map((child) => (
                      <ArticleCard key={child._id} article={child} compact />
                    ))}
                  </div>
                </section>
              )
            ) : (
              Object.entries(childrenByType).map(([type, items]) => (
                <section key={type} className="mb-12">
                  <h2 className="font-display text-xl md:text-2xl font-extrabold tracking-[-0.02em] text-navy-900 mb-4">
                    {CONTENT_TYPE_LABELS[type] || type}
                  </h2>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {items.map((child) => (
                      <ArticleCard key={child._id} article={child} compact />
                    ))}
                  </div>
                </section>
              ))
            )}

            {filtered.length === 0 && (
              <p className="text-navy-600 text-center py-12">{t('learn.noArticles', 'No articles available yet.')}</p>
            )}
          </>
        )}
      </MarketingSection>
    </MarketingLayout>
  );
}

function ArticleCard({
  article,
  compact,
  hub,
}: {
  article: LearningArticleSummary;
  compact?: boolean;
  hub?: boolean;
}) {
  return (
    <LocalizedLink to={`/learn/${article.slug}`} className="block h-full group">
      <div
        className={cn(
          'card-chip h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock',
          compact ? 'p-4' : 'p-6',
        )}
      >
        <div className="flex flex-wrap gap-1.5 mb-3">
          {article.contentType && (
            <span className="text-xs rounded-full bg-brand-50 text-brand-700 px-2 py-0.5 font-semibold uppercase tracking-wide">
              {CONTENT_TYPE_LABELS[article.contentType] || article.contentType}
            </span>
          )}
          {article.skillLevel && (
            <span className="text-xs rounded-full border border-navy-100 text-navy-700 px-2 py-0.5 font-medium">
              {SKILL_LEVEL_LABELS[article.skillLevel] || article.skillLevel}
            </span>
          )}
          {article.pageType === 'hub' && (
            <span className="text-xs rounded-full bg-navy-900 text-white px-2 py-0.5 font-semibold uppercase tracking-wide">
              Guide
            </span>
          )}
        </div>
        {hub && (
          <IconTile icon={<BookOpen className="h-5 w-5" />} className="mb-3" />
        )}
        <h3
          className={cn(
            'font-display font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors',
            compact ? 'text-sm' : 'text-base md:text-lg',
          )}
        >
          {article.h1}
        </h3>
        <p className={cn('text-navy-600', compact ? 'text-xs line-clamp-2' : 'text-sm line-clamp-3')}>
          {article.intro}
        </p>
      </div>
    </LocalizedLink>
  );
}
