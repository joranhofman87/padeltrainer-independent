import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { PortableTextRenderer } from '@/components/sanity/PortableTextRenderer';
import { motion } from 'framer-motion';
import { ArrowLeft, User, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getTopicBySlug } from '@/lib/topics';
import { CONTENT_TYPE_LABELS, SKILL_LEVEL_LABELS } from '@/lib/learningArticles';
import { MARKETING_DOMAIN } from '@/lib/domains';
import type { TopicDetail } from '@/lib/topics';

function TopicSkeleton() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <Skeleton className="h-6 w-48 mb-4" />
      <Skeleton className="h-10 w-full mb-4" />
      <Skeleton className="h-10 w-3/4 mb-6" />
      <Skeleton className="h-24 w-full mb-8" />
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

function buildStructuredData(topic: TopicDetail, slug: string, currentLang: string) {
  const url = `${MARKETING_DOMAIN}/${currentLang}/topics/${slug}`;

  const collectionPage = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": topic.seo?.titleTag || topic.h1 || topic.title,
    "description": topic.seo?.metaDescription || topic.description || topic.intro,
    "url": url,
    "inLanguage": currentLang,
    "publisher": {
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "logo": { "@type": "ImageObject", "url": `${MARKETING_DOMAIN}/favicon.png` },
    },
  };

  const webPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": topic.seo?.titleTag || topic.h1 || topic.title,
    "description": topic.seo?.metaDescription || topic.description || topic.intro,
    "url": url,
    "inLanguage": currentLang,
    "isPartOf": {
      "@type": "WebSite",
      "name": "PadelTrainer.ai",
      "url": MARKETING_DOMAIN,
    },
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `${MARKETING_DOMAIN}/${currentLang}` },
      { "@type": "ListItem", "position": 2, "name": "Topics", "item": `${MARKETING_DOMAIN}/${currentLang}/topics` },
      { "@type": "ListItem", "position": 3, "name": topic.seo?.breadcrumbLabel || topic.h1 || topic.title, "item": url },
    ],
  };

  return [collectionPage, webPage, breadcrumbSchema];
}

export default function TopicPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation('marketing');
  const currentLang = i18n.language || 'en';

  const { data: topic, isLoading, error } = useQuery({
    queryKey: ['topic', slug],
    queryFn: () => getTopicBySlug(slug!),
    enabled: !!slug,
    staleTime: 1000 * 60 * 10,
  });

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/topics" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('topics.backToTopics', 'Back to Topics')}
            </LocalizedLink>
          </Button>
        </div>
        <TopicSkeleton />
      </MarketingLayout>
    );
  }

  if (error || !topic) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">{t('topics.notFound', 'Topic not found')}</h1>
          <p className="text-muted-foreground mb-6">{t('topics.notFoundDesc', 'This topic page could not be found.')}</p>
          <Button asChild>
            <LocalizedLink to="/topics">{t('topics.backToTopics', 'Back to Topics')}</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const structuredData = buildStructuredData(topic, slug!, currentLang);

  const breadcrumbItems = [
    { label: t('topics.title', 'Topics'), href: '/topics' },
    { label: topic.seo?.breadcrumbLabel || topic.h1 || topic.title },
  ];

  return (
    <MarketingLayout>
      <SEO
        title={topic.seo?.titleTag || topic.h1 || topic.title}
        description={topic.seo?.metaDescription || topic.description || topic.intro || ''}
        url={`/topics/${slug}`}
        type="website"
        structuredData={structuredData}
        noIndex={!topic.isIndexable}
      />

      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <LocalizedLink to="/topics" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('topics.backToTopics', 'Back to Topics')}
          </LocalizedLink>
        </Button>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <Breadcrumbs items={breadcrumbItems} />

        <article>
          {/* Header */}
          <motion.header initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex flex-wrap gap-2 mb-4">
              {topic.contentType && (
                <Badge variant="secondary">
                  {CONTENT_TYPE_LABELS[topic.contentType] || topic.contentType}
                </Badge>
              )}
              {topic.skillLevel && (
                <Badge variant="outline">
                  {SKILL_LEVEL_LABELS[topic.skillLevel] || topic.skillLevel}
                </Badge>
              )}
            </div>
            <h1 className="text-3xl md:text-4xl font-bold mb-4">
              {topic.h1 || topic.title}
            </h1>
          </motion.header>

          {/* Intro */}
          {topic.intro && (
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
              className="text-lg text-muted-foreground mb-8 leading-relaxed"
            >
              {topic.intro}
            </motion.p>
          )}

          {/* Portable Text Content */}
          {topic.content && topic.content.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              className="mb-12"
            >
              <PortableTextRenderer content={topic.content} />
            </motion.div>
          )}

          {/* ═══ Featured Content Sections ═══ */}

          {/* Featured Guides */}
          {topic.featuredGuides && topic.featuredGuides.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                <BookOpen className="h-5 w-5 inline-block mr-2 text-primary" />
                {t('topics.featuredGuides', 'Guides')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {topic.featuredGuides.map(guide => (
                  <LocalizedLink key={guide._id} to={`/learn/${guide.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-5">
                        <div className="flex gap-2 mb-2">
                          {guide.contentType && (
                            <Badge variant="secondary" className="text-xs">
                              {CONTENT_TYPE_LABELS[guide.contentType] || guide.contentType}
                            </Badge>
                          )}
                          {guide.skillLevel && (
                            <Badge variant="outline" className="text-xs">
                              {SKILL_LEVEL_LABELS[guide.skillLevel] || guide.skillLevel}
                            </Badge>
                          )}
                        </div>
                        <CardTitle className="text-base mb-2 hover:text-primary transition-colors">
                          {guide.h1}
                        </CardTitle>
                        <p className="text-sm text-muted-foreground line-clamp-2">{guide.intro}</p>
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Featured Rules */}
          {topic.featuredRules && topic.featuredRules.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('topics.featuredRules', 'Related Rules')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {topic.featuredRules.map(rule => (
                  <LocalizedLink key={rule._id} to={`/padel-rules/${rule.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-4">
                        <CardTitle className="text-base mb-1 hover:text-primary transition-colors">
                          {rule.h1}
                        </CardTitle>
                        {rule.quickAnswer && (
                          <p className="text-sm text-muted-foreground line-clamp-2">{rule.quickAnswer}</p>
                        )}
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Featured Strokes */}
          {topic.featuredStrokes && topic.featuredStrokes.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('topics.featuredStrokes', 'Related Strokes')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {topic.featuredStrokes.map(stroke => (
                  <LocalizedLink key={stroke._id} to={`/padel-strokes/${stroke.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-4">
                        <div className="flex gap-2 mb-2">
                          {stroke.category && <Badge variant="secondary" className="text-xs">{stroke.category}</Badge>}
                          {stroke.difficulty && <Badge variant="outline" className="text-xs">{stroke.difficulty}</Badge>}
                        </div>
                        <CardTitle className="text-base mb-1 hover:text-primary transition-colors">
                          {stroke.h1}
                        </CardTitle>
                        {stroke.shortDescription && (
                          <p className="text-sm text-muted-foreground line-clamp-2">{stroke.shortDescription}</p>
                        )}
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Featured Video Tips */}
          {topic.featuredVideoTips && topic.featuredVideoTips.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('topics.featuredVideos', 'Video Tips')}
              </h2>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {topic.featuredVideoTips.map(video => (
                  <LocalizedLink key={video._id} to={`/video-tips/${video.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-4">
                        <CardTitle className="text-sm mb-1 hover:text-primary transition-colors">
                          {video.title}
                        </CardTitle>
                        {video.shortSummary && (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{video.shortSummary}</p>
                        )}
                        {video.trainer && (
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
                            <User className="h-3 w-3" />
                            {video.trainer.name}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Featured Creators */}
          {topic.featuredTrainers && topic.featuredTrainers.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('topics.featuredTrainers', 'Featured Creators')}
              </h2>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {topic.featuredTrainers.map(trainer => (
                  <LocalizedLink key={trainer._id} to={`/padel-coaches/${trainer.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-4 flex items-center gap-4">
                        {trainer.profileImageUrl ? (
                          <img
                            src={trainer.profileImageUrl}
                            alt={trainer.name}
                            className="h-12 w-12 rounded-full object-cover flex-shrink-0"
                            loading="lazy"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                            <User className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        <div>
                          <CardTitle className="text-base hover:text-primary transition-colors">
                            {trainer.name}
                          </CardTitle>
                          {trainer.shortTagline && (
                            <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                              {trainer.shortTagline}
                            </p>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Related Topics */}
          {topic.relatedTopics && topic.relatedTopics.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('topics.relatedTopics', 'Related Topics')}
              </h2>
              <div className="flex flex-wrap gap-3">
                {topic.relatedTopics.map(related => (
                  <LocalizedLink key={related._id} to={`/topics/${related.slug}`}>
                    <Badge
                      variant="outline"
                      className="text-sm px-4 py-2 hover:bg-accent transition-colors cursor-pointer"
                    >
                      {related.title}
                    </Badge>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Parent Topic */}
          {topic.parentTopic && (
            <div className="mt-8 p-4 border rounded-lg bg-card">
              <LocalizedLink
                to={`/topics/${topic.parentTopic.slug}`}
                className="flex items-center gap-2 text-primary hover:underline font-medium"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('topics.backToParent', 'Back to')} {topic.parentTopic.title}
              </LocalizedLink>
            </div>
          )}
        </article>
      </div>
    </MarketingLayout>
  );
}
