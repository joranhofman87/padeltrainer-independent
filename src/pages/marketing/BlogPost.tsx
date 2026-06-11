import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { BodySections } from '@/components/sanity/BodySections';
import { PortableTextRenderer, extractHeadings } from '@/components/sanity/PortableTextRenderer';
import { TableOfContents } from '@/components/sanity/TableOfContents';
import { CTASection } from '@/components/sanity/CTASection';
import { BannerZone } from '@/components/sponsors/BannerZone';
import { HubHero } from '@/components/blog/HubHero';
import { RelatedGuidesSection } from '@/components/blog/RelatedGuidesSection';
import { isHubPage, getSpokeArticles } from '@/lib/hubPages';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowLeft, Share2 } from 'lucide-react';
import { getArticleBySlug, calculateReadTime } from '@/lib/blog';
import { formatDate } from '@/lib/format';
import { useTranslation } from 'react-i18next';
import { getTranslations } from '@/lib/translations';
import { useTranslationsContext } from '@/contexts/TranslationsContext';

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
  const lang = i18n.language || 'en';
  const hub = slug ? isHubPage(slug) : false;

  const { data: post, isLoading, error } = useQuery({
    queryKey: ['blog-post', slug, lang],
    queryFn: () => getArticleBySlug(slug!, lang),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  // Fetch spoke articles for hub pages
  const { data: spokeArticles = [] } = useQuery({
    queryKey: ['hub-spokes', slug, lang],
    queryFn: () => getSpokeArticles(slug!, lang),
    enabled: hub && !!slug,
    staleTime: 1000 * 60 * 10,
  });

  // Fetch translations for language switcher + hreflang
  const { setTranslations, clearTranslations } = useTranslationsContext();
  const { data: translationsList = [] } = useQuery({
    queryKey: ['translations', 'blogPost', post?._id],
    queryFn: () => getTranslations(post!._id, 'blogPost', lang, post!.translationOf?._ref),
    enabled: !!post?._id,
    staleTime: 1000 * 60 * 10,
  });

  useEffect(() => {
    if (translationsList.length > 0) {
      setTranslations(translationsList, 'blog');
    }
    return () => clearTranslations();
  }, [translationsList, setTranslations, clearTranslations]);

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild aria-label={t('blog.backToBlog')}>
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
          <Button asChild aria-label={t('blog.notFound.backToBlog')}>
            <LocalizedLink to="/blog">{t('blog.notFound.backToBlog')}</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const readTime = calculateReadTime(post.bodySections, post.content);
  const headings = post.content ? extractHeadings(post.content) : [];

  const postUrl = `https://padeltrainer.ai/${lang}/blog/${slug}`;
  const postImage = 'https://padeltrainer.ai/og-image.png';

  // BreadcrumbList structured data for all blog posts
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `https://padeltrainer.ai/${lang}` },
      { "@type": "ListItem", "position": 2, "name": "Blog", "item": `https://padeltrainer.ai/${lang}/blog` },
      { "@type": "ListItem", "position": 3, "name": post.h1 || post.title },
    ],
  };

  // Build structured data based on hub vs regular
  const articleSchema = hub
    ? {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": post.h1 || post.title,
        "description": post.seo?.metaDescription || post.excerpt || post.title,
        "url": postUrl,
        "mainEntity": {
          "@type": "Article",
          "headline": post.h1 || post.title,
          "description": post.seo?.metaDescription || post.excerpt || post.title,
          "datePublished": post.datePublished,
          "author": { "@type": "Organization", "name": "PadelTrainer.ai" },
        },
        "hasPart": spokeArticles.map((a) => ({
          "@type": "Article",
          "name": a.title,
          "url": `https://padeltrainer.ai/${lang}/blog/${a.slug}`,
        })),
      }
    : {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": post.h1 || post.title,
        "datePublished": post.datePublished,
        "dateModified": post.dateModified,
        "url": postUrl,
        "image": postImage,
        "mainEntityOfPage": { "@type": "WebPage", "@id": postUrl },
        "author": {
          "@type": "Person",
          "name": post.authorName || "PadelTrainer.ai",
        },
        "publisher": {
          "@type": "Organization",
          "name": "PadelTrainer.ai",
          "logo": { "@type": "ImageObject", "url": "https://padeltrainer.ai/favicon.png" },
        },
        "description": post.seo?.metaDescription || post.excerpt || post.title,
        "speakable": {
          "@type": "SpeakableSpecification",
          "cssSelector": ["h1", ".prose"],
        },
        "isPartOf": {
          "@type": "Blog",
          "name": "PadelTrainer.ai Blog",
          "url": `https://padeltrainer.ai/${lang}/blog`,
        },
      };

  const structuredData = [breadcrumbSchema, articleSchema];

  // ─── Hub Page Layout ───
  if (hub) {
    return (
      <MarketingLayout>
        <SEO
          title={post.seo?.titleTag || post.h1 || post.title}
          description={post.seo?.metaDescription || post.excerpt || `Read about ${post.title} on PadelTrainer.ai`}
          url={`/blog/${slug}`}
          type="article"
          structuredData={structuredData}
          noIndex={post.seo?.indexable === false}
          translations={translationsList}
          pathPrefix="blog"
          publishedTime={post.datePublished || undefined}
          modifiedTime={post.dateModified || undefined}
          author={post.authorName || 'PadelTrainer.ai'}
        />

        {/* Back Button */}
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild aria-label={t('blog.backToBlog')}>
            <LocalizedLink to="/blog" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('blog.backToBlog')}
            </LocalizedLink>
          </Button>
        </div>

        {/* Hub Hero */}
        <HubHero
          title={post.h1 || post.title}
          excerpt={post.excerpt}
          category={post.category}
          datePublished={post.datePublished}
          readTime={readTime}
          authorName={post.authorName}
        />

        <article className="container mx-auto px-4 py-8 max-w-[900px]">
          <Breadcrumbs items={[
            { label: t('common:breadcrumbs.blog', 'Blog'), href: '/blog' },
            { label: post.seo?.breadcrumbLabel || post.h1 || post.title },
          ]} />

          {/* Table of Contents */}
          {headings.length >= 2 && (
            <TableOfContents headings={headings} className="my-8 p-4 rounded-lg border border-border bg-muted/30" />
          )}

          {/* Article Content */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            {post.content && post.content.length > 0 ? (
              <PortableTextRenderer content={post.content} />
            ) : (
              <BodySections sections={post.bodySections} />
            )}
          </motion.div>

          {/* Sponsor Banner */}
          <BannerZone zone="in-article" category={post.category} className="my-8" />

          {/* Related Guides */}
          <RelatedGuidesSection articles={spokeArticles} />

          {/* CTA */}
          <CTASection cta={post.cta} />
        </article>
      </MarketingLayout>
    );
  }

  // ─── Regular Blog Post Layout ───
  return (
    <MarketingLayout>
      <SEO
        title={post.seo?.titleTag || post.h1 || post.title}
        description={post.seo?.metaDescription || post.excerpt || `Read about ${post.title} on PadelTrainer.ai`}
        url={`/blog/${slug}`}
        type="article"
        structuredData={structuredData}
        noIndex={post.seo?.indexable === false}
        translations={translationsList}
        pathPrefix="blog"
        publishedTime={post.datePublished || undefined}
        modifiedTime={post.dateModified || undefined}
        author={post.authorName || 'PadelTrainer.ai'}
      />

      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild aria-label={t('blog.backToBlog')}>
          <LocalizedLink to="/blog" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('blog.backToBlog')}
          </LocalizedLink>
        </Button>
      </div>

      {/* Article */}
      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <Breadcrumbs items={[
          { label: t('common:breadcrumbs.blog', 'Blog'), href: '/blog' },
          { label: post.seo?.breadcrumbLabel || post.h1 || post.title },
        ]} />

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          {post.category && <Badge className="mb-4">{post.category}</Badge>}
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{post.h1 || post.title}</h1>
          <div className="flex items-center gap-4 text-muted-foreground mb-8 flex-wrap">
            {post.datePublished && (
              <span className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                {formatDate(post.datePublished, 'd MMMM yyyy')}
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
          {post.content && post.content.length > 0 ? (
            <PortableTextRenderer content={post.content} />
          ) : (
            <BodySections sections={post.bodySections} />
          )}
        </motion.div>

        {/* Sponsor Banner */}
        <BannerZone zone="in-article" category={post.category} className="my-8" />

        {/* CTA */}
        <CTASection cta={post.cta} />
      </article>
    </MarketingLayout>
  );
}
