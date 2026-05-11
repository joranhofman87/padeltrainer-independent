import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { Tag, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getTopics } from '@/lib/topics';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { MarketingHero, MarketingSection } from '@/components/marketing/sections';

function IndexSkeleton() {
  return (
    <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
      {Array.from({ length: 9 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-2xl" />
      ))}
    </div>
  );
}

export default function TopicsIndex() {
  const { t, i18n } = useTranslation('marketing');
  const currentLang = i18n.language || 'en';

  const { data: topics = [], isLoading } = useQuery({
    queryKey: ['topics-index'],
    queryFn: () => getTopics(true),
    staleTime: 1000 * 60 * 10,
  });

  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: t('topics.seoTitle', 'Padel Topics - Explore All Topics'),
      description: t('topics.seoDescription', 'Browse padel topics including serve, volley, tactics, drills, and more.'),
      url: `${MARKETING_DOMAIN}/${currentLang}/topics`,
      publisher: { '@type': 'Organization', name: 'PadelTrainer.ai' },
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: topics.map((topic, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${MARKETING_DOMAIN}/${currentLang}/topics/${topic.slug}`,
          name: topic.title,
        })),
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${MARKETING_DOMAIN}/${currentLang}` },
        { '@type': 'ListItem', position: 2, name: 'Topics', item: `${MARKETING_DOMAIN}/${currentLang}/topics` },
      ],
    },
  ];

  return (
    <MarketingLayout>
      <SEO
        title={t('topics.seoTitle', 'Padel Topics - Explore All Topics')}
        description={t('topics.seoDescription', 'Browse padel topics including serve, volley, tactics, drills, and more.')}
        url="/topics"
        type="website"
        structuredData={structuredData}
      />

      <MarketingHero
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Tag className="h-3.5 w-3.5" />
            {t('topics.eyebrow', 'Topic hubs')}
          </span>
        }
        title={t('topics.title', 'Topics')}
        subtitle={t('topics.subtitle', 'Explore padel topics to find guides, rules, strokes, video tips, and more.')}
        compact
      />

      <div className="max-w-5xl mx-auto px-4 md:px-6">
        <Breadcrumbs items={[{ label: t('topics.title', 'Topics') }]} />
      </div>

      <MarketingSection background="default" align="left" containerClassName="max-w-5xl">
        <p className="text-base text-navy-600 max-w-2xl mb-10">
          {t('topics.hubIntro', 'Each topic page brings together our best articles, drills, video tips, and expert trainers so you can dive deep into any area of padel.')}
        </p>

        {isLoading ? (
          <IndexSkeleton />
        ) : (
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
            {topics.map((topic, i) => (
              <motion.div
                key={topic._id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
              >
                <LocalizedLink to={`/topics/${topic.slug}`} className="block h-full group">
                  <div className="card-chip p-5 h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
                    <h3 className="font-display text-base font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors capitalize">
                      {topic.title}
                    </h3>
                    {topic.description && (
                      <p className="text-sm text-navy-600 line-clamp-2">{topic.description}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {topic.articleCount > 0 && (
                        <span className="inline-flex items-center text-xs rounded-full border border-navy-100 text-navy-700 px-2 py-0.5 font-medium">
                          <FileText className="h-3 w-3 mr-1" />
                          {topic.articleCount} {topic.articleCount === 1 ? 'article' : 'articles'}
                        </span>
                      )}
                      {topic.contentType && (
                        <span className="text-xs rounded-full bg-brand-50 text-brand-700 px-2 py-0.5 font-semibold">
                          {topic.contentType}
                        </span>
                      )}
                      {topic.skillLevel && (
                        <span className="text-xs rounded-full border border-navy-100 text-navy-700 px-2 py-0.5 font-medium">
                          {topic.skillLevel}
                        </span>
                      )}
                    </div>
                  </div>
                </LocalizedLink>
              </motion.div>
            ))}
          </div>
        )}

        {!isLoading && topics.length === 0 && (
          <p className="text-navy-600 text-center py-12">{t('topics.noTopics', 'No topics available yet.')}</p>
        )}
      </MarketingSection>
    </MarketingLayout>
  );
}
