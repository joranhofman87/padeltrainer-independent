import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowLeft, Share2 } from 'lucide-react';
import { getBlogPostBySlug } from '@/lib/contentful';
import { documentToReactComponents } from '@contentful/rich-text-react-renderer';
import { BLOCKS, INLINES } from '@contentful/rich-text-types';
import type { Options } from '@contentful/rich-text-react-renderer';
import { useTranslation } from 'react-i18next';

// Rich text rendering options
const richTextOptions: Options = {
  renderNode: {
    [BLOCKS.PARAGRAPH]: (node, children) => (
      <p className="text-muted-foreground mb-4 leading-relaxed">{children}</p>
    ),
    [BLOCKS.HEADING_1]: (node, children) => (
      <h1 className="text-3xl font-bold text-foreground mt-8 mb-4">{children}</h1>
    ),
    [BLOCKS.HEADING_2]: (node, children) => (
      <h2 className="text-2xl font-bold text-foreground mt-8 mb-4">{children}</h2>
    ),
    [BLOCKS.HEADING_3]: (node, children) => (
      <h3 className="text-xl font-bold text-foreground mt-6 mb-3">{children}</h3>
    ),
    [BLOCKS.HEADING_4]: (node, children) => (
      <h4 className="text-lg font-bold text-foreground mt-6 mb-3">{children}</h4>
    ),
    [BLOCKS.UL_LIST]: (node, children) => (
      <ul className="list-disc list-inside text-muted-foreground mb-4 space-y-2">{children}</ul>
    ),
    [BLOCKS.OL_LIST]: (node, children) => (
      <ol className="list-decimal list-inside text-muted-foreground mb-4 space-y-2">{children}</ol>
    ),
    [BLOCKS.LIST_ITEM]: (node, children) => (
      <li>{children}</li>
    ),
    [BLOCKS.QUOTE]: (node, children) => (
      <blockquote className="border-l-4 border-primary pl-4 italic text-muted-foreground my-6">
        {children}
      </blockquote>
    ),
    [BLOCKS.EMBEDDED_ASSET]: (node) => {
      const { file, title } = node.data.target.fields;
      return (
        <img
          src={`https:${file.url}`}
          alt={title || ''}
          className="rounded-lg my-6 w-full"
        />
      );
    },
    [INLINES.HYPERLINK]: (node, children) => (
      <a 
        href={node.data.uri} 
        className="text-primary hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
  },
};

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
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </article>
  );
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation('marketing');
  
  const { data: post, isLoading, error } = useQuery({
    queryKey: ['blog-post', slug, i18n.language],
    queryFn: () => getBlogPostBySlug(slug!, i18n.language),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  
  const dateLocale = i18n.language === 'nl' ? 'nl-NL' : 'en-US';

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
          <p className="text-muted-foreground mb-6">
            {t('blog.notFound.description')}
          </p>
          <Button asChild>
            <LocalizedLink to="/blog">{t('blog.notFound.backToBlog')}</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  return (
    <MarketingLayout>
      {/* Back Button */}
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/blog" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('blog.backToBlog')}
            </LocalizedLink>
          </Button>
        </div>

      {/* Article Header */}
      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Badge className="mb-4">Blog</Badge>
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{post.title}</h1>
          <div className="flex items-center gap-4 text-muted-foreground mb-8">
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              {new Date(post.date).toLocaleDateString(dateLocale, { 
                month: 'long', 
                day: 'numeric',
                year: 'numeric'
              })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {post.readTime}
            </span>
            <Button variant="ghost" size="sm">
              <Share2 className="h-4 w-4 mr-2" />
              {t('blog.share')}
            </Button>
          </div>
        </motion.div>

        {/* Featured Image */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="aspect-video bg-muted rounded-xl overflow-hidden mb-8"
        >
          <img 
            src={post.image} 
            alt={post.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </motion.div>

        {/* Article Content */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="prose prose-lg max-w-none"
        >
          {documentToReactComponents(post.content, richTextOptions)}
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-12 p-8 bg-accent/30 rounded-xl text-center"
        >
          <h3 className="text-xl font-bold mb-2">{t('blog.readyToFind')}</h3>
          <p className="text-muted-foreground mb-4">
            {t('blog.browseTrainers')}
          </p>
          <Button asChild>
            <LocalizedLink to="/trainers">{t('blog.findTrainers')}</LocalizedLink>
          </Button>
        </motion.div>
      </article>
    </MarketingLayout>
  );
}
