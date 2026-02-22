import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowLeft, Share2 } from 'lucide-react';
import { getArticleBySlug, getRelatedArticles, calculateReadTime } from '@/lib/blog';
import type { Article } from '@/lib/blog';
import { useTranslation } from 'react-i18next';

function BlogPostSkeleton() {
  return (
    <article className="container mx-auto px-4 py-8 max-w-3xl">
      <Skeleton className="h-6 w-24 mb-4" />
      <Skeleton className="h-10 w-full mb-4" />
      <Skeleton className="h-10 w-3/4 mb-4" />
      <div className="flex gap-4 mb-8">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="aspect-video w-full rounded-xl mb-8" />
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </article>
  );
}

function RelatedPosts({ articles, dateLocale }: { articles: Article[]; dateLocale: string }) {
  const { t } = useTranslation('marketing');
  if (articles.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="text-2xl font-bold mb-6">{t('blog.relatedArticles', 'Related Articles')}</h2>
      <div className="grid md:grid-cols-3 gap-6">
        {articles.map(article => (
          <LocalizedLink key={article.id} to={`/blog/${article.slug}`}>
            <div className="group">
              <div className="aspect-video bg-muted rounded-lg overflow-hidden mb-3">
                <img src={article.cover_image_url || '/placeholder.svg'} alt={article.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform" loading="lazy" />
              </div>
              <h3 className="font-semibold line-clamp-2 group-hover:text-primary transition-colors">{article.title}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {article.published_at && new Date(article.published_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}
              </p>
            </div>
          </LocalizedLink>
        ))}
      </div>
    </section>
  );
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation('marketing');

  const { data: post, isLoading, error } = useQuery({
    queryKey: ['blog-post', slug, i18n.language],
    queryFn: () => getArticleBySlug(slug!, i18n.language),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  const { data: related = [] } = useQuery({
    queryKey: ['blog-related', post?.id, i18n.language],
    queryFn: () => getRelatedArticles(post!.id, i18n.language, post!.tags),
    enabled: !!post,
    staleTime: 1000 * 60 * 5,
  });

  const dateLocale = i18n.language === 'nl' ? 'nl-NL' : i18n.language === 'de' ? 'de-DE' : i18n.language === 'es' ? 'es-ES' : i18n.language === 'fr' ? 'fr-FR' : 'en-US';

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/blog" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('blog.backToBlog')}
            </LocalizedLink>
          </Button>
        </div>
        <BlogPostSkeleton />
      </MarketingLayout>
    );
  }

  if (error || !post) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">{t('blog.notFound.title')}</h1>
          <p className="text-muted-foreground mb-6">{t('blog.notFound.description')}</p>
          <Button asChild>
            <LocalizedLink to="/blog">{t('blog.notFound.backToBlog')}</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const readTime = calculateReadTime(post.body_html);

  // Hreflang links for SEO component
  const hreflangLinks = post.translations?.map(tr => ({
    locale: tr.locale,
    url: `/blog/${tr.slug}`,
  })) || [];

  const articleStructuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": post.title,
    "image": post.cover_image_url,
    "datePublished": post.published_at,
    "dateModified": post.updated_at,
    "author": {
      "@type": "Organization",
      "name": post.author_name || "PadelTrainer.ai"
    },
    "publisher": {
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "logo": { "@type": "ImageObject", "url": "https://padeltrainer.ai/favicon.png" }
    },
    "description": post.meta_description || post.excerpt || post.title
  };

  return (
    <MarketingLayout>
      <SEO
        title={post.meta_title || post.title}
        description={post.meta_description || post.excerpt || `Read about ${post.title} on PadelTrainer.ai`}
        url={`/blog/${slug}`}
        type="article"
        image={post.cover_image_url || undefined}
        structuredData={articleStructuredData}
      />
      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <LocalizedLink to="/blog" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('blog.backToBlog')}
          </LocalizedLink>
        </Button>
      </div>

      {/* Article */}
      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          {post.tags?.[0] && <Badge className="mb-4">{post.tags[0]}</Badge>}
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{post.title}</h1>
          <div className="flex items-center gap-4 text-muted-foreground mb-8">
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              {post.published_at && new Date(post.published_at).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {readTime}
            </span>
            <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(window.location.href)}>
              <Share2 className="h-4 w-4 mr-2" />
              {t('blog.share')}
            </Button>
          </div>
        </motion.div>

        {/* Cover Image */}
        {post.cover_image_url && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="aspect-video bg-muted rounded-xl overflow-hidden mb-8">
            <img src={post.cover_image_url} alt={post.title} className="w-full h-full object-cover" loading="lazy" />
          </motion.div>
        )}

        {/* Article Content (HTML) */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="prose prose-lg max-w-none dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: post.body_html || '' }}
        />

        {/* Related Posts */}
        <RelatedPosts articles={related} dateLocale={dateLocale} />

        {/* CTA */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="mt-12 p-8 bg-accent/30 rounded-xl text-center">
          <h3 className="text-xl font-bold mb-2">{t('blog.readyToFind', 'Ready to find your perfect padel trainer?')}</h3>
          <p className="text-muted-foreground mb-4">{t('blog.browseTrainers', 'Browse our network of certified trainers.')}</p>
          <Button asChild>
            <LocalizedLink to="/trainers">{t('blog.findTrainers', 'Find Trainers')}</LocalizedLink>
          </Button>
        </motion.div>
      </article>
    </MarketingLayout>
  );
}
