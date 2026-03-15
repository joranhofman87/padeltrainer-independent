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
import { PortableTextRenderer, extractHeadings } from '@/components/sanity/PortableTextRenderer';
import { TableOfContents } from '@/components/sanity/TableOfContents';
import { CommonMistakes } from '@/components/sanity/CommonMistakes';
import { CTASection } from '@/components/sanity/CTASection';
import { motion } from 'framer-motion';
import { ArrowLeft, BookOpen, User, Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getLearningArticleBySlug, CONTENT_TYPE_LABELS, SKILL_LEVEL_LABELS } from '@/lib/learningArticles';
import type { LearningArticleDetail } from '@/lib/learningArticles';
import { MARKETING_DOMAIN } from '@/lib/domains';

function ArticleSkeleton() {
  return (
    <article className="container mx-auto px-4 py-8 max-w-4xl">
      <Skeleton className="h-6 w-48 mb-4" />
      <Skeleton className="h-10 w-full mb-4" />
      <Skeleton className="h-10 w-3/4 mb-6" />
      <Skeleton className="h-24 w-full mb-8" />
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </article>
  );
}

function formatDate(dateStr: string | null, lang: string): string | null {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString(lang, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function buildStructuredData(article: LearningArticleDetail, slug: string, currentLang: string) {
  const url = `${MARKETING_DOMAIN}/${currentLang}/learn/${slug}`;
  const base = {
    "@context": "https://schema.org",
    "headline": article.h1,
    "description": article.seo?.metaDescription || article.intro,
    "url": url,
    "datePublished": article.datePublished,
    "dateModified": article.dateModified,
    "author": { "@type": "Organization", "name": "PadelTrainer.ai" },
    "publisher": {
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "logo": { "@type": "ImageObject", "url": `${MARKETING_DOMAIN}/favicon.png` }
    },
    "inLanguage": currentLang,
  };

  const articleSchema = article.pageType === 'hub'
    ? { ...base, "@type": "CollectionPage" }
    : { ...base, "@type": "Article" };

  // WebPage schema
  const webPageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": article.seo?.titleTag || article.h1,
    "description": article.seo?.metaDescription || article.intro,
    "url": url,
    "inLanguage": currentLang,
    "isPartOf": {
      "@type": "WebSite",
      "name": "PadelTrainer.ai",
      "url": MARKETING_DOMAIN,
    },
  };

  // Breadcrumb structured data
  const breadcrumbItems = [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": `${MARKETING_DOMAIN}/${currentLang}` },
    { "@type": "ListItem", "position": 2, "name": "Learn", "item": `${MARKETING_DOMAIN}/${currentLang}/learn` },
  ];

  if (article.pageType === 'child') {
    const parentHub = article.relatedGuides?.find(g => g.pageType === 'hub');
    if (parentHub) {
      breadcrumbItems.push({
        "@type": "ListItem",
        "position": 3,
        "name": parentHub.h1,
        "item": `${MARKETING_DOMAIN}/${currentLang}/learn/${parentHub.slug}`,
      });
      breadcrumbItems.push({
        "@type": "ListItem",
        "position": 4,
        "name": article.seo?.breadcrumbLabel || article.h1,
        "item": url,
      });
    } else {
      breadcrumbItems.push({
        "@type": "ListItem",
        "position": 3,
        "name": article.seo?.breadcrumbLabel || article.h1,
        "item": url,
      });
    }
  } else {
    breadcrumbItems.push({
      "@type": "ListItem",
      "position": 3,
      "name": article.seo?.breadcrumbLabel || article.h1,
      "item": url,
    });
  }

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": breadcrumbItems,
  };

  return [articleSchema, webPageSchema, breadcrumbSchema];
}

export default function LearningArticlePage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation('marketing');
  const currentLang = i18n.language || 'en';

  const { data: article, isLoading, error } = useQuery({
    queryKey: ['learning-article', slug],
    queryFn: () => getLearningArticleBySlug(slug!),
    enabled: !!slug,
    staleTime: 1000 * 60 * 10,
  });

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/learn" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('learn.backToLearn', 'Back to Learn')}
            </LocalizedLink>
          </Button>
        </div>
        <ArticleSkeleton />
      </MarketingLayout>
    );
  }

  if (error || !article) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">{t('learn.notFound', 'Article not found')}</h1>
          <p className="text-muted-foreground mb-6">{t('learn.notFoundDesc', 'This article could not be found.')}</p>
          <Button asChild>
            <LocalizedLink to="/learn">{t('learn.backToLearn', 'Back to Learn')}</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const headings = extractHeadings(article.content);
  const parentHub = article.pageType === 'child' ? article.relatedGuides?.find(g => g.pageType === 'hub') : null;
  const childGuides = article.relatedGuides?.filter(g => g.pageType === 'child') || [];
  const hubGuides = article.pageType === 'hub'
    ? article.relatedGuides || []
    : childGuides;

  // Build breadcrumb items
  const breadcrumbItems: { label: string; href?: string }[] = [
    { label: t('learn.title', 'Learn Padel'), href: '/learn' },
  ];
  if (article.pageType === 'child' && parentHub) {
    breadcrumbItems.push({ label: parentHub.h1, href: `/learn/${parentHub.slug}` });
  }
  breadcrumbItems.push({ label: article.seo?.breadcrumbLabel || article.h1 });

  const structuredData = buildStructuredData(article, slug!, currentLang);

  const publishedFormatted = formatDate(article.datePublished, currentLang);
  const modifiedFormatted = formatDate(article.dateModified, currentLang);
  const showModified = article.dateModified && article.datePublished && article.dateModified !== article.datePublished;

  return (
    <MarketingLayout>
      <SEO
        title={article.seo?.titleTag || article.h1}
        description={article.seo?.metaDescription || article.intro}
        url={`/learn/${slug}`}
        type="article"
        structuredData={structuredData}
        noIndex={article.seo?.indexable === false}
      />

      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <LocalizedLink
            to={parentHub ? `/learn/${parentHub.slug}` : '/learn'}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {parentHub ? parentHub.h1 : t('learn.backToLearn', 'Back to Learn')}
          </LocalizedLink>
        </Button>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <Breadcrumbs items={breadcrumbItems} />

        {/* Article Header */}
        <article>
          <motion.header initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex flex-wrap gap-2 mb-4">
              {article.contentType && (
                <Badge variant="secondary">
                  {CONTENT_TYPE_LABELS[article.contentType] || article.contentType}
                </Badge>
              )}
              {article.skillLevel && (
                <Badge variant="outline">
                  {SKILL_LEVEL_LABELS[article.skillLevel] || article.skillLevel}
                </Badge>
              )}
              {article.pageType === 'hub' && (
                <Badge className="bg-primary/10 text-primary border-primary/20">Guide</Badge>
              )}
            </div>
            <h1 className="text-3xl md:text-4xl font-bold mb-4">{article.h1}</h1>

            {/* Publish / Modified dates */}
            {publishedFormatted && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground mb-6">
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  <time dateTime={article.datePublished!}>{publishedFormatted}</time>
                </span>
                {showModified && modifiedFormatted && (
                  <span className="text-xs">
                    ({t('learn.updated', 'Updated')}{' '}
                    <time dateTime={article.dateModified!}>{modifiedFormatted}</time>)
                  </span>
                )}
              </div>
            )}
          </motion.header>

          {/* Intro */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="text-lg text-muted-foreground mb-8 leading-relaxed"
          >
            {article.intro}
          </motion.p>

          {/* Quick Answer */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-6 bg-primary/5 border border-primary/20 rounded-xl mb-8"
          >
            <div className="flex items-start gap-3">
              <BookOpen className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
              <div>
                <h2 className="font-semibold mb-2 text-primary">
                  {t('learn.quickAnswer', 'Quick Answer')}
                </h2>
                <p className="text-foreground">{article.quickAnswer}</p>
              </div>
            </div>
          </motion.div>

          {/* Topics — crawlable links */}
          {article.topics && article.topics.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-8">
              {article.topics.map(topic => (
                <LocalizedLink
                  key={topic._id}
                  to={`/topics/${topic.slug}`}
                >
                  <Badge variant="outline" className="text-xs hover:bg-accent transition-colors cursor-pointer">
                    {topic.title}
                  </Badge>
                </LocalizedLink>
              ))}
            </div>
          )}

          {/* Layout: content + TOC sidebar on desktop */}
          <div className="lg:grid lg:grid-cols-[1fr_220px] lg:gap-12">
            {/* Main Content */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
            >
              <PortableTextRenderer content={article.content} />
            </motion.div>

            {/* Table of Contents - sticky sidebar on desktop */}
            {headings.length >= 2 && (
              <aside className="hidden lg:block">
                <TableOfContents
                  headings={headings}
                  className="sticky top-24 p-4 border rounded-lg bg-card"
                />
              </aside>
            )}
          </div>

          {/* Common Mistakes */}
          {article.commonMistakes && article.commonMistakes.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="mt-8"
            >
              <CommonMistakes mistakes={article.commonMistakes} />
            </motion.div>
          )}

          {/* ═══ Related Content Sections ═══ */}

          {/* Hub: Child guides grid */}
          {article.pageType === 'hub' && hubGuides.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('learn.inThisGuide', 'In This Guide')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {hubGuides.map(guide => (
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

          {/* Child: Related Guides (siblings + hub) */}
          {article.pageType === 'child' && childGuides.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('learn.relatedGuides', 'Related Guides')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {childGuides.map(guide => (
                  <LocalizedLink key={guide._id} to={`/learn/${guide.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-5">
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

          {/* Related Rules */}
          {article.relatedRules && article.relatedRules.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('learn.relatedRules', 'Related Rules')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {article.relatedRules.map(rule => (
                  <LocalizedLink key={rule._id} to={`/padel-rules/${rule.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-4">
                        <CardTitle className="text-base mb-1 hover:text-primary transition-colors">
                          {rule.h1}
                        </CardTitle>
                        <p className="text-sm text-muted-foreground line-clamp-2">{rule.quickAnswer}</p>
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Related Strokes */}
          {article.relatedStrokes && article.relatedStrokes.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('learn.relatedStrokes', 'Related Strokes')}
              </h2>
              <div className="grid md:grid-cols-2 gap-4">
                {article.relatedStrokes.map(stroke => (
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
                        <p className="text-sm text-muted-foreground line-clamp-2">{stroke.shortDescription}</p>
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                ))}
              </div>
            </section>
          )}

          {/* Related Video Tips */}
          {article.relatedVideoTips && article.relatedVideoTips.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('learn.relatedVideos', 'Video Tips')}
              </h2>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {article.relatedVideoTips.map(video => (
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

          {/* Featured Trainers */}
          {article.featuredTrainers && article.featuredTrainers.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold mb-6">
                {t('learn.featuredTrainers', 'Featured Coaches')}
              </h2>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {article.featuredTrainers.map(trainer => (
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

          {/* Back to hub CTA for child pages */}
          {article.pageType === 'child' && parentHub && (
            <div className="mt-8 p-4 border rounded-lg bg-card">
              <LocalizedLink
                to={`/learn/${parentHub.slug}`}
                className="flex items-center gap-2 text-primary hover:underline font-medium"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('learn.backToHub', 'Back to')} {parentHub.h1}
              </LocalizedLink>
            </div>
          )}

          {/* CTA */}
          <CTASection cta={article.cta} />
        </article>
      </div>
    </MarketingLayout>
  );
}
