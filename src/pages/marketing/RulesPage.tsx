import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, AlertCircle, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, RULES_BY_SLUG_QUERY } from '@/lib/sanity';

interface BodySection {
  heading: string;
  content: string;
}

interface RulesArticleDetail {
  _id: string;
  title: string;
  slug: string;
  h1: string;
  intro: string;
  quickAnswer: string;
  pageType: 'hub' | 'child';
  bodySections: BodySection[] | null;
  commonMistakes: string[] | null;
  seo: { titleTag: string; metaDescription: string; breadcrumbLabel?: string } | null;
  cta: { label: string; url: string } | null;
  datePublished: string | null;
  dateModified: string | null;
  relatedRules: { _id: string; title: string; slug: string; h1: string; quickAnswer: string; pageType: string }[] | null;
}

function RulesPageSkeleton() {
  return (
    <article className="container mx-auto px-4 py-8 max-w-3xl">
      <Skeleton className="h-6 w-24 mb-4" />
      <Skeleton className="h-10 w-full mb-4" />
      <Skeleton className="h-10 w-3/4 mb-8" />
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </article>
  );
}

export default function RulesPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation('marketing');

  const { data: article, isLoading, error } = useQuery({
    queryKey: ['rules-page', slug],
    queryFn: () => sanityClient.fetch<RulesArticleDetail>(RULES_BY_SLUG_QUERY, { slug }),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/rules" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              {t('rules.backToRules', 'Back to Rules')}
            </LocalizedLink>
          </Button>
        </div>
        <RulesPageSkeleton />
      </MarketingLayout>
    );
  }

  if (error || !article) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">{t('rules.notFound', 'Rule not found')}</h1>
          <p className="text-muted-foreground mb-6">{t('rules.notFoundDescription', 'This rules page could not be found.')}</p>
          <Button asChild>
            <LocalizedLink to="/rules">{t('rules.backToRules', 'Back to Rules')}</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": article.h1,
    "datePublished": article.datePublished,
    "dateModified": article.dateModified,
    "author": { "@type": "Organization", "name": "PadelTrainer.ai" },
    "publisher": {
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "logo": { "@type": "ImageObject", "url": "https://padeltrainer.ai/favicon.png" }
    },
    "description": article.seo?.metaDescription || article.intro
  };

  return (
    <MarketingLayout>
      <SEO
        title={article.seo?.titleTag || article.h1}
        description={article.seo?.metaDescription || article.intro}
        url={`/rules/${slug}`}
        type="article"
        structuredData={structuredData}
      />

      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <LocalizedLink to="/rules" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('rules.backToRules', 'Back to Rules')}
          </LocalizedLink>
        </Button>
      </div>

      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <Badge className="mb-4" variant="secondary">
            {article.pageType === 'hub' ? t('rules.guide', 'Guide') : t('rules.rule', 'Rule')}
          </Badge>
          <h1 className="text-3xl md:text-4xl font-bold mb-6">{article.h1}</h1>
        </motion.div>

        {/* Intro */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-lg text-muted-foreground mb-8 leading-relaxed"
        >
          {article.intro}
        </motion.p>

        {/* Quick Answer */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="p-6 bg-primary/5 border border-primary/20 rounded-xl mb-8"
        >
          <div className="flex items-start gap-3">
            <BookOpen className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
            <div>
              <h2 className="font-semibold mb-2 text-primary">{t('rules.quickAnswer', 'Quick Answer')}</h2>
              <p className="text-foreground">{article.quickAnswer}</p>
            </div>
          </div>
        </motion.div>

        {/* Body Sections */}
        {article.bodySections && article.bodySections.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="prose prose-lg max-w-none dark:prose-invert mb-8"
          >
            {article.bodySections.map((section, i) => (
              <div key={i} className="mb-8">
                <h2>{section.heading}</h2>
                {section.content.split('\n\n').map((paragraph, j) => (
                  <p key={j}>{paragraph}</p>
                ))}
              </div>
            ))}
          </motion.div>
        )}

        {/* Common Mistakes */}
        {article.commonMistakes && article.commonMistakes.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="p-6 bg-destructive/5 border border-destructive/20 rounded-xl mb-8"
          >
            <div className="flex items-start gap-3 mb-4">
              <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
              <h2 className="font-semibold text-destructive">{t('rules.commonMistakes', 'Common Mistakes')}</h2>
            </div>
            <ul className="space-y-2 ml-8">
              {article.commonMistakes.map((mistake, i) => (
                <li key={i} className="text-foreground list-disc">{mistake}</li>
              ))}
            </ul>
          </motion.div>
        )}

        {/* Related Rules */}
        {article.relatedRules && article.relatedRules.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mt-12"
          >
            <h2 className="text-2xl font-bold mb-6">{t('rules.relatedRules', 'Related Rules')}</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {article.relatedRules.map(rule => (
                <LocalizedLink key={rule._id} to={`/rules/${rule.slug}`}>
                  <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                    <CardContent className="p-4">
                      <CardTitle className="text-base mb-1 hover:text-primary transition-colors">{rule.h1}</CardTitle>
                      <p className="text-sm text-muted-foreground line-clamp-2">{rule.quickAnswer}</p>
                    </CardContent>
                  </Card>
                </LocalizedLink>
              ))}
            </div>
          </motion.div>
        )}

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="mt-12 p-8 bg-accent/30 rounded-xl text-center"
        >
          <h3 className="text-xl font-bold mb-2">
            {article.cta?.label || t('rules.ctaTitle', 'Ready to play by the rules?')}
          </h3>
          <p className="text-muted-foreground mb-4">{t('rules.ctaDescription', 'Find a certified padel trainer near you.')}</p>
          <Button asChild>
            <LocalizedLink to={article.cta?.url || '/trainers'}>
              {t('blog.findTrainers', 'Find Trainers')} <ArrowRight className="h-4 w-4 ml-2" />
            </LocalizedLink>
          </Button>
        </motion.div>
      </article>
    </MarketingLayout>
  );
}
