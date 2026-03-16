import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { Tag, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getTopics } from '@/lib/topics';
import { MARKETING_DOMAIN } from '@/lib/domains';

function IndexSkeleton() {
  return (
    <div className="container mx-auto px-4 py-12 max-w-5xl">
      <Skeleton className="h-10 w-64 mb-4" />
      <Skeleton className="h-6 w-96 mb-8" />
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
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
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "name": t('topics.seoTitle', 'Padel Topics – Explore All Topics'),
      "description": t('topics.seoDescription', 'Browse padel topics including serve, volley, tactics, drills, and more.'),
      "url": `${MARKETING_DOMAIN}/${currentLang}/topics`,
      "publisher": { "@type": "Organization", "name": "PadelTrainer.ai" },
      "mainEntity": {
        "@type": "ItemList",
        "itemListElement": topics.map((topic, i) => ({
          "@type": "ListItem",
          "position": i + 1,
          "url": `${MARKETING_DOMAIN}/${currentLang}/topics/${topic.slug}`,
          "name": topic.title,
        })),
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": `${MARKETING_DOMAIN}/${currentLang}` },
        { "@type": "ListItem", "position": 2, "name": "Topics", "item": `${MARKETING_DOMAIN}/${currentLang}/topics` },
      ],
    },
  ];

  return (
    <MarketingLayout>
      <SEO
        title={t('topics.seoTitle', 'Padel Topics – Explore All Topics')}
        description={t('topics.seoDescription', 'Browse padel topics including serve, volley, tactics, drills, and more.')}
        url="/topics"
        type="website"
        structuredData={structuredData}
      />

      <div className="container mx-auto px-4 py-12 max-w-5xl">
        <Breadcrumbs items={[{ label: t('topics.title', 'Topics') }]} />

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-10"
        >
          <div className="flex items-center gap-3 mb-4">
            <Tag className="h-8 w-8 text-primary" />
            <h1 className="text-3xl md:text-4xl font-bold">
              {t('topics.title', 'Topics')}
            </h1>
          </div>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {t('topics.subtitle', 'Explore padel topics to find guides, rules, strokes, video tips, and more.')}
          </p>
          <p className="text-base text-muted-foreground max-w-2xl mt-2">
            {t('topics.hubIntro', 'Each topic page brings together our best articles, drills, video tips, and expert trainers so you can dive deep into any area of padel.')}
          </p>
        </motion.div>

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
                <LocalizedLink to={`/topics/${topic.slug}`} className="block h-full">
                  <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                    <CardContent className="p-5">
                      <CardTitle className="text-base mb-2 hover:text-primary transition-colors capitalize">
                        {topic.title}
                      </CardTitle>
                      {topic.description && (
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {topic.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {topic.articleCount > 0 && (
                          <Badge variant="outline" className="text-xs">
                            <FileText className="h-3 w-3 mr-1" />
                            {topic.articleCount} {topic.articleCount === 1 ? 'article' : 'articles'}
                          </Badge>
                        )}
                        {topic.contentType && (
                          <Badge variant="secondary" className="text-xs">{topic.contentType}</Badge>
                        )}
                        {topic.skillLevel && (
                          <Badge variant="outline" className="text-xs">{topic.skillLevel}</Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </LocalizedLink>
              </motion.div>
            ))}
          </div>
        )}

        {!isLoading && topics.length === 0 && (
          <p className="text-muted-foreground text-center py-12">
            {t('topics.noTopics', 'No topics available yet.')}
          </p>
        )}
      </div>
    </MarketingLayout>
  );
}
