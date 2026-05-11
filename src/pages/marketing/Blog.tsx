import { LocalizedLink } from '@/components/LocalizedLink';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowRight, FileText } from 'lucide-react';
import { getPublishedArticles, getAllCategories, calculateReadTime } from '@/lib/blog';
import type { Article } from '@/lib/blog';
import { useTranslation } from 'react-i18next';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { useState } from 'react';
import { BannerZone } from '@/components/sponsors/BannerZone';
import { MarketingHero, MarketingSection, MarketingFinalCTA } from '@/components/marketing/sections';
import { cn } from '@/lib/utils';

function BlogPostCardSkeleton() {
  return (
    <div className="card-chip p-6">
      <Skeleton className="h-5 w-20 mb-3" />
      <Skeleton className="h-6 w-full mb-2" />
      <Skeleton className="h-4 w-full mb-4" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation('marketing');
  return (
    <div className="text-center py-16">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-navy-50 mb-4">
        <FileText className="h-8 w-8 text-navy-500" />
      </div>
      <h2 className="font-display text-xl font-bold text-navy-900 mb-2">{t('blog.notFound.title')}</h2>
      <p className="text-navy-600 max-w-md mx-auto">{t('blog.notFound.description')}</p>
    </div>
  );
}

function ArticleCard({ article, dateLocale, index }: { article: Article; dateLocale: string; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.05 }}
    >
      <LocalizedLink to={`/blog/${article.slug}`} className="block group h-full">
        <div className="card-chip p-6 h-full flex flex-col transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
          {article.category && (
            <span className="self-start text-xs rounded-full bg-brand-50 text-brand-700 px-2.5 py-1 font-semibold uppercase tracking-wide mb-3">
              {article.category}
            </span>
          )}
          <h3 className="font-display text-lg font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors line-clamp-2">
            {article.h1 || article.title}
          </h3>
          <p className="text-navy-600 line-clamp-2 mb-4 flex-1">{article.excerpt}</p>
          <div className="flex items-center gap-4 text-xs text-navy-500">
            <span>
              {article.datePublished
                ? new Date(article.datePublished).toLocaleDateString(dateLocale, {
                    month: 'short',
                    day: 'numeric',
                  })
                : ''}
            </span>
            <span>{calculateReadTime(article.bodySections, article.content)}</span>
          </div>
        </div>
      </LocalizedLink>
    </motion.div>
  );
}

export default function Blog() {
  const { t, i18n } = useTranslation('marketing');
  const lang = i18n.language || 'en';
  const [page, setPage] = useState(1);
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>();

  const { data, isLoading } = useQuery({
    queryKey: ['blog-posts', page, selectedCategory, lang],
    queryFn: () => getPublishedArticles(page, selectedCategory, lang),
    staleTime: 1000 * 60 * 5,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['blog-categories', lang],
    queryFn: () => getAllCategories(lang),
    staleTime: 1000 * 60 * 10,
  });

  const articles = data?.articles || [];
  const featuredPost = articles.find((a) => a.isFeatured) || articles[0];
  const recentPosts = articles.filter((a) => a !== featuredPost);
  const dateLocale =
    i18n.language === 'nl'
      ? 'nl-NL'
      : i18n.language === 'de'
        ? 'de-DE'
        : i18n.language === 'es'
          ? 'es-ES'
          : i18n.language === 'fr'
            ? 'fr-FR'
            : 'en-US';

  const breadcrumbListSD = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('nav.home', 'Home'), item: `${MARKETING_DOMAIN}/${lang}` },
      { '@type': 'ListItem', position: 2, name: t('blog.title', 'Blog') },
    ],
  };

  const blogSD =
    articles.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: t('blog.title'),
          description: t('blog.subtitle'),
          url: `${MARKETING_DOMAIN}/blog`,
          blogPost: articles.slice(0, 10).map((a) => ({
            '@type': 'BlogPosting',
            headline: a.title,
            description: a.excerpt,
            datePublished: a.datePublished,
            ...(a.authorName ? { author: { '@type': 'Person', name: a.authorName } } : {}),
            url: `${MARKETING_DOMAIN}/${lang}/blog/${a.slug}`,
          })),
        }
      : undefined;

  const structuredData = [breadcrumbListSD, ...(blogSD ? [blogSD] : [])];

  return (
    <MarketingLayout>
      <SEO title={t('blog.title')} description={t('blog.subtitle')} url="/blog" structuredData={structuredData} />

      <MarketingHero
        eyebrow={t('blog.eyebrow', 'Stories & insights')}
        title={t('blog.title')}
        subtitle={t('blog.subtitle')}
        compact
      />

      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <Breadcrumbs items={[{ label: t('blog.title', 'Blog') }]} />
      </div>

      {/* Category filters */}
      {categories.length > 0 && (
        <section className="border-b border-navy-100">
          <div className="max-w-7xl mx-auto px-4 md:px-6 py-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedCategory(undefined);
                setPage(1);
              }}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                !selectedCategory
                  ? 'bg-navy-900 text-white'
                  : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
              )}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setSelectedCategory(cat);
                  setPage(1);
                }}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                  selectedCategory === cat
                    ? 'bg-navy-900 text-white'
                    : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Content */}
      {isLoading ? (
        <MarketingSection background="default">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <BlogPostCardSkeleton key={i} />
            ))}
          </div>
        </MarketingSection>
      ) : articles.length === 0 ? (
        <MarketingSection background="default">
          <EmptyState />
        </MarketingSection>
      ) : (
        <>
          {/* Featured Post */}
          {featuredPost && (
            <section className="py-12 md:py-16">
              <div className="max-w-7xl mx-auto px-4 md:px-6">
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                >
                  <LocalizedLink to={`/blog/${featuredPost.slug}`} className="block group">
                    <div className="card-chip p-8 md:p-10 transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
                      {featuredPost.category && (
                        <span className="inline-block text-xs rounded-full bg-brand-50 text-brand-700 px-2.5 py-1 font-semibold uppercase tracking-wide mb-4">
                          {featuredPost.category}
                        </span>
                      )}
                      <h2 className="font-display text-2xl md:text-4xl font-extrabold tracking-[-0.02em] text-navy-900 mb-4 group-hover:text-brand-600 transition-colors">
                        {featuredPost.h1 || featuredPost.title}
                      </h2>
                      <p className="text-base md:text-lg text-navy-600 mb-4">{featuredPost.excerpt}</p>
                      <div className="flex flex-wrap items-center gap-4 text-sm text-navy-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          {featuredPost.datePublished &&
                            new Date(featuredPost.datePublished).toLocaleDateString(dateLocale, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          {calculateReadTime(featuredPost.bodySections, featuredPost.content)}
                        </span>
                        <span>by {featuredPost.authorName || 'Padel Trainer AI'}</span>
                      </div>
                    </div>
                  </LocalizedLink>
                </motion.div>
              </div>
            </section>
          )}

          <BannerZone zone="blog-listing" category={selectedCategory} className="max-w-7xl mx-auto px-4 md:px-6 py-6" />

          {recentPosts.length > 0 && (
            <MarketingSection
              background="default"
              heading={t('blog.recentArticles')}
              align="left"
              headerClassName="mb-8 md:mb-10"
            >
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {recentPosts.map((article, index) => (
                  <ArticleCard key={article._id} article={article} dateLocale={dateLocale} index={index} />
                ))}
              </div>
            </MarketingSection>
          )}

          {data && data.totalPages > 1 && (
            <section className="py-8">
              <div className="max-w-7xl mx-auto px-4 md:px-6 flex justify-center gap-2">
                {Array.from({ length: data.totalPages }, (_, i) => i + 1).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPage(p)}
                    className={cn(
                      'h-9 min-w-9 rounded-full px-3 text-sm font-semibold transition-colors',
                      p === page
                        ? 'bg-navy-900 text-white'
                        : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <MarketingFinalCTA
        title={t('blog.readyToFind', 'Ready to find your perfect padel trainer?')}
        body={t('blog.browseTrainers', 'Browse our network of certified trainers.')}
        primaryHref={`/${lang}/trainers`}
        primaryLabel={
          <>
            {t('blog.findTrainers', 'Find Trainers')}
            <ArrowRight className="ml-2 h-5 w-5" />
          </>
        }
      />
    </MarketingLayout>
  );
}
