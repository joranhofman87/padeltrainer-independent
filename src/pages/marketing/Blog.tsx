import { LocalizedLink } from '@/components/LocalizedLink';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowRight, FileText } from 'lucide-react';
import { getPublishedArticles, getAllCategories, calculateReadTime } from '@/lib/blog';
import type { Article } from '@/lib/blog';
import { useTranslation } from 'react-i18next';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { useState } from 'react';

function BlogPostCardSkeleton() {
  return (
    <Card className="h-full">
      <CardContent className="p-6">
        <Skeleton className="h-5 w-20 mb-3" />
        <Skeleton className="h-6 w-full mb-2" />
        <Skeleton className="h-4 w-full mb-4" />
        <Skeleton className="h-4 w-32" />
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  const { t } = useTranslation('marketing');
  return (
    <div className="text-center py-16">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
        <FileText className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="text-xl font-semibold mb-2">{t('blog.notFound.title')}</h2>
      <p className="text-muted-foreground max-w-md mx-auto">
        {t('blog.notFound.description')}
      </p>
    </div>
  );
}

function ArticleCard({ article, dateLocale, index }: { article: Article; dateLocale: string; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.1 }}
    >
      <LocalizedLink to={`/blog/${article.slug}`}>
        <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
          <CardContent className="p-6">
            {article.category && (
              <Badge variant="secondary" className="mb-3">{article.category}</Badge>
            )}
            <CardTitle className="text-lg mb-2 hover:text-primary transition-colors line-clamp-2">
              {article.h1 || article.title}
            </CardTitle>
            <CardDescription className="line-clamp-2 mb-4">
              {article.excerpt}
            </CardDescription>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>{article.datePublished ? new Date(article.datePublished).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' }) : ''}</span>
              <span>{calculateReadTime(article.bodySections, article.content)}</span>
            </div>
          </CardContent>
        </Card>
      </LocalizedLink>
    </motion.div>
  );
}

export default function Blog() {
  const { t, i18n } = useTranslation('marketing');
  const [page, setPage] = useState(1);
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>();

  const { data, isLoading } = useQuery({
    queryKey: ['blog-posts', page, selectedCategory],
    queryFn: () => getPublishedArticles(page, selectedCategory),
    staleTime: 1000 * 60 * 5,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['blog-categories'],
    queryFn: () => getAllCategories(),
    staleTime: 1000 * 60 * 10,
  });

  const articles = data?.articles || [];
  const featuredPost = articles.find(a => a.isFeatured) || articles[0];
  const recentPosts = articles.filter(a => a !== featuredPost);
  const dateLocale = i18n.language === 'nl' ? 'nl-NL' : i18n.language === 'de' ? 'de-DE' : i18n.language === 'es' ? 'es-ES' : i18n.language === 'fr' ? 'fr-FR' : 'en-US';

  const structuredData = articles.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: t('blog.title'),
    description: t('blog.subtitle'),
    url: `${MARKETING_DOMAIN}/blog`,
    blogPost: articles.slice(0, 10).map(a => ({
      '@type': 'BlogPosting',
      headline: a.title,
      description: a.excerpt,
      datePublished: a.datePublished,
      url: `${MARKETING_DOMAIN}/blog/${a.slug}`
    }))
  } : undefined;

  return (
    <MarketingLayout>
      <SEO
        title={t('blog.title')}
        description={t('blog.subtitle')}
        url="/blog"
        structuredData={structuredData}
      />
      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('blog.title')}</h1>
            <p className="text-xl text-muted-foreground">{t('blog.subtitle')}</p>
          </motion.div>
        </div>
      </section>

      {/* Category filters */}
      {categories.length > 0 && (
        <section className="py-4 border-b">
          <div className="container mx-auto px-4 flex flex-wrap gap-2">
            <Badge
              variant={!selectedCategory ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => { setSelectedCategory(undefined); setPage(1); }}
            >
              All
            </Badge>
            {categories.map(cat => (
              <Badge
                key={cat}
                variant={selectedCategory === cat ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => { setSelectedCategory(cat); setPage(1); }}
              >
                {cat}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {/* Content */}
      {isLoading ? (
        <section className="py-12">
          <div className="container mx-auto px-4">
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map(i => <BlogPostCardSkeleton key={i} />)}
            </div>
          </div>
        </section>
      ) : articles.length === 0 ? (
        <section className="py-12">
          <div className="container mx-auto px-4"><EmptyState /></div>
        </section>
      ) : (
        <>
          {/* Featured Post */}
          {featuredPost && (
            <section className="py-12">
              <div className="container mx-auto px-4">
                <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
                  <LocalizedLink to={`/blog/${featuredPost.slug}`}>
                    <Card className="overflow-hidden hover:shadow-lg transition-shadow border-2 hover:border-primary/20">
                      <CardContent className="p-8">
                        {featuredPost.category && <Badge className="w-fit mb-4">{featuredPost.category}</Badge>}
                        <CardTitle className="text-2xl md:text-3xl mb-4 hover:text-primary transition-colors">{featuredPost.h1 || featuredPost.title}</CardTitle>
                        <CardDescription className="text-base mb-4">{featuredPost.excerpt}</CardDescription>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-4 w-4" />
                            {featuredPost.datePublished && new Date(featuredPost.datePublished).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            {calculateReadTime(featuredPost.bodySections)}
                          </span>
                          {featuredPost.authorName && (
                            <span>by {featuredPost.authorName}</span>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                </motion.div>
              </div>
            </section>
          )}

          {/* Recent Posts Grid */}
          {recentPosts.length > 0 && (
            <section className="py-12">
              <div className="container mx-auto px-4">
                <h2 className="text-2xl font-bold mb-8">{t('blog.recentArticles')}</h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {recentPosts.map((article, index) => (
                    <ArticleCard key={article._id} article={article} dateLocale={dateLocale} index={index} />
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <section className="py-8">
              <div className="container mx-auto px-4 flex justify-center gap-2">
                {Array.from({ length: data.totalPages }, (_, i) => i + 1).map(p => (
                  <Button key={p} variant={p === page ? 'default' : 'outline'} size="sm" onClick={() => setPage(p)}>
                    {p}
                  </Button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* CTA */}
      <section className="py-16 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-xl mx-auto" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-2xl font-bold mb-4">{t('blog.readyToFind', 'Ready to find your perfect padel trainer?')}</h2>
            <p className="text-muted-foreground mb-6">{t('blog.browseTrainers', 'Browse our network of certified trainers.')}</p>
            <Button asChild>
              <LocalizedLink to="/trainers" className="flex items-center gap-2">
                {t('blog.findTrainers', 'Find Trainers')}
                <ArrowRight className="h-4 w-4" />
              </LocalizedLink>
            </Button>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
