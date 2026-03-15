import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLearningArticles, CONTENT_TYPE_LABELS, SKILL_LEVEL_LABELS } from '@/lib/learningArticles';
import type { LearningArticleSummary } from '@/lib/learningArticles';
import { MARKETING_DOMAIN } from '@/lib/domains';

function IndexSkeleton() {
  return (
    <div className="container mx-auto px-4 py-12 max-w-5xl">
      <Skeleton className="h-10 w-64 mb-4" />
      <Skeleton className="h-6 w-96 mb-8" />
      <div className="grid md:grid-cols-2 gap-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function LearnIndex() {
  const { t, i18n } = useTranslation('marketing');
  const currentLang = i18n.language || 'en';

  const { data: articles = [], isLoading } = useQuery({
    queryKey: ['learning-articles'],
    queryFn: getLearningArticles,
    staleTime: 1000 * 60 * 10,
  });

  // Separate hubs and children
  const hubs = articles.filter(a => a.pageType === 'hub');
  const children = articles.filter(a => a.pageType === 'child');

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "Learn Padel",
    "description": "Guides, tactics, drills, and everything you need to improve your padel game.",
    "url": `${MARKETING_DOMAIN}/${currentLang}/learn`,
    "publisher": { "@type": "Organization", "name": "PadelTrainer.ai" },
    "mainEntity": {
      "@type": "ItemList",
      "itemListElement": articles.slice(0, 50).map((article, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "url": `${MARKETING_DOMAIN}/${currentLang}/learn/${article.slug}`,
        "name": article.h1,
      })),
    },
  };

  return (
    <MarketingLayout>
      <SEO
        title="Learn Padel – Guides, Tactics & Drills"
        description="Guides, tactics, drills, and everything you need to improve your padel game. From beginner to advanced."
        url="/learn"
        type="website"
        structuredData={structuredData}
      />

      <div className="container mx-auto px-4 py-12 max-w-5xl">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-12"
        >
          <div className="flex items-center gap-3 mb-4">
            <BookOpen className="h-8 w-8 text-primary" />
            <h1 className="text-3xl md:text-4xl font-bold">
              {t('learn.title', 'Learn Padel')}
            </h1>
          </div>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {t('learn.subtitle', 'Guides, tactics, drills, and everything you need to improve your padel game.')}
          </p>
        </motion.div>

        {isLoading ? (
          <IndexSkeleton />
        ) : (
          <>
            {/* Hub pages = featured guides */}
            {hubs.length > 0 && (
              <section className="mb-12">
                <h2 className="text-2xl font-bold mb-6">
                  {t('learn.guides', 'Guides')}
                </h2>
                <div className="grid md:grid-cols-2 gap-6">
                  {hubs.map(hub => (
                    <ArticleCard key={hub._id} article={hub} />
                  ))}
                </div>
              </section>
            )}

            {/* Child articles */}
            {children.length > 0 && (
              <section>
                <h2 className="text-2xl font-bold mb-6">
                  {t('learn.allArticles', 'All Articles')}
                </h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {children.map(child => (
                    <ArticleCard key={child._id} article={child} compact />
                  ))}
                </div>
              </section>
            )}

            {articles.length === 0 && (
              <p className="text-muted-foreground text-center py-12">
                {t('learn.noArticles', 'No articles available yet.')}
              </p>
            )}
          </>
        )}
      </div>
    </MarketingLayout>
  );
}

function ArticleCard({ article, compact }: { article: LearningArticleSummary; compact?: boolean }) {
  return (
    <LocalizedLink to={`/learn/${article.slug}`} className="block h-full">
      <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
        <CardContent className={compact ? 'p-4' : 'p-5'}>
          <div className="flex flex-wrap gap-2 mb-3">
            {article.contentType && (
              <Badge variant="secondary" className="text-xs">
                {CONTENT_TYPE_LABELS[article.contentType] || article.contentType}
              </Badge>
            )}
            {article.skillLevel && (
              <Badge variant="outline" className="text-xs">
                {SKILL_LEVEL_LABELS[article.skillLevel] || article.skillLevel}
              </Badge>
            )}
            {article.pageType === 'hub' && (
              <Badge className="bg-primary/10 text-primary border-primary/20 text-xs">Guide</Badge>
            )}
          </div>
          <CardTitle className={`${compact ? 'text-sm' : 'text-base'} mb-2 hover:text-primary transition-colors`}>
            {article.h1}
          </CardTitle>
          <p className={`text-muted-foreground ${compact ? 'text-xs line-clamp-2' : 'text-sm line-clamp-3'}`}>
            {article.intro}
          </p>
        </CardContent>
      </Card>
    </LocalizedLink>
  );
}
