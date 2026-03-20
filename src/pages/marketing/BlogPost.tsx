import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { BodySections } from '@/components/sanity/BodySections';
import { PortableTextRenderer } from '@/components/sanity/PortableTextRenderer';
import { CTASection } from '@/components/sanity/CTASection';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowLeft, Share2 } from 'lucide-react';
import { getArticleBySlug, calculateReadTime } from '@/lib/blog';
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
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </article>
  );
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation('marketing');

  const { data: post, isLoading, error } = useQuery({
    queryKey: ['blog-post', slug],
    queryFn: () => getArticleBySlug(slug!),
    enabled: !!slug,
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

  const readTime = calculateReadTime(post.bodySections);

  const articleStructuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": post.h1 || post.title,
    "datePublished": post.datePublished,
    "dateModified": post.dateModified,
    "author": {
      "@type": "Person",
      "name": post.authorName || "PadelTrainer.ai"
    },
    "publisher": {
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "logo": { "@type": "ImageObject", "url": "https://padeltrainer.ai/favicon.png" }
    },
    "description": post.seo?.metaDescription || post.excerpt || post.title
  };

  return (
    <MarketingLayout>
      <SEO
        title={post.seo?.titleTag || post.h1 || post.title}
        description={post.seo?.metaDescription || post.excerpt || `Read about ${post.title} on PadelTrainer.ai`}
        url={`/blog/${slug}`}
        type="article"
        structuredData={articleStructuredData}
        noIndex={post.seo?.indexable === false}
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
        <Breadcrumbs items={[
          { label: 'Blog', href: '/blog' },
          { label: post.seo?.breadcrumbLabel || post.h1 || post.title },
        ]} />

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          {post.category && <Badge className="mb-4">{post.category}</Badge>}
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{post.h1 || post.title}</h1>
          <div className="flex items-center gap-4 text-muted-foreground mb-8 flex-wrap">
            {post.datePublished && (
              <span className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                {new Date(post.datePublished).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {readTime}
            </span>
            {post.authorName && <span>by {post.authorName}</span>}
            <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(window.location.href)}>
              <Share2 className="h-4 w-4 mr-2" />
              {t('blog.share')}
            </Button>
          </div>
        </motion.div>

        {/* Article Content */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <BodySections sections={post.bodySections} />
        </motion.div>

        {/* CTA */}
        <CTASection cta={post.cta} />
      </article>
    </MarketingLayout>
  );
}
