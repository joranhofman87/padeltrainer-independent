import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { BodySections } from '@/components/sanity/BodySections';
import { CommonMistakes } from '@/components/sanity/CommonMistakes';
import { CTASection } from '@/components/sanity/CTASection';
import { VideoTipCard } from '@/components/sanity/VideoTipCard';
import type { VideoTip } from '@/components/sanity/VideoTipCard';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, STROKE_BY_SLUG_QUERY, VIDEO_TIPS_BY_STROKE_QUERY } from '@/lib/sanity';
import type { SeoFields, CtaFields, BodySection } from '@/lib/sanity';
import { getTranslations } from '@/lib/translations';
import { useTranslationsContext } from '@/contexts/TranslationsContext';

interface StrokeDetail {
  _id: string;
  title: string;
  slug: string;
  h1: string;
  shortDescription: string;
  category: string | null;
  difficulty: string | null;
  keyTips: string[] | null;
  bodySections: BodySection[] | null;
  commonMistakes: string[] | null;
  seo: SeoFields | null;
  cta: CtaFields | null;
  relatedStrokes: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    shortDescription: string;
    category: string | null;
    difficulty: string | null;
  }[] | null;
  relatedRules: {
    _id: string;
    title: string;
    slug: string;
    h1: string;
    quickAnswer: string;
    pageType: string;
  }[] | null;
}

export default function StrokePage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, i18n } = useTranslation('marketing');
  const lang = i18n.language || 'en';

  const { data: stroke, isLoading, error } = useQuery({
    queryKey: ['stroke-page', slug, lang],
    queryFn: () => sanityClient.fetch<StrokeDetail>(STROKE_BY_SLUG_QUERY, { slug, lang }),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  const { data: videoTips = [] } = useQuery({
    queryKey: ['stroke-videos', stroke?._id, lang],
    queryFn: () => sanityClient.fetch<VideoTip[]>(VIDEO_TIPS_BY_STROKE_QUERY, { strokeId: stroke!._id, lang }),
    enabled: !!stroke?._id,
    staleTime: 1000 * 60 * 5,
  });

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/padel-strokes" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" /> Back to Strokes
            </LocalizedLink>
          </Button>
        </div>
        <article className="container mx-auto px-4 py-8 max-w-3xl">
          <Skeleton className="h-10 w-full mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4" />
        </article>
      </MarketingLayout>
    );
  }

  if (error || !stroke) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">Stroke not found</h1>
          <p className="text-muted-foreground mb-6">This stroke page could not be found.</p>
          <Button asChild>
            <LocalizedLink to="/padel-strokes">Back to Strokes</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": stroke.h1,
    "description": stroke.seo?.metaDescription || stroke.shortDescription,
    "author": { "@type": "Organization", "name": "PadelTrainer.ai" },
    "publisher": {
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "logo": { "@type": "ImageObject", "url": "https://padeltrainer.ai/favicon.png" }
    },
  };

  return (
    <MarketingLayout>
      <SEO
        title={stroke.seo?.titleTag || stroke.h1}
        description={stroke.seo?.metaDescription || stroke.shortDescription}
        url={`/padel-strokes/${slug}`}
        type="article"
        structuredData={structuredData}
        noIndex={stroke.seo?.indexable === false}
      />

      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <LocalizedLink to="/padel-strokes" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" /> Back to Strokes
          </LocalizedLink>
        </Button>
      </div>

      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <Breadcrumbs items={[
          { label: 'Strokes', href: '/padel-strokes' },
          { label: stroke.seo?.breadcrumbLabel || stroke.h1 },
        ]} />

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex gap-2 mb-4">
            {stroke.category && <Badge variant="secondary">{stroke.category}</Badge>}
            {stroke.difficulty && <Badge variant="outline">{stroke.difficulty}</Badge>}
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{stroke.h1}</h1>
          <p className="text-lg text-muted-foreground mb-8 leading-relaxed">{stroke.shortDescription}</p>
        </motion.div>

        {/* Key Tips */}
        {stroke.keyTips && stroke.keyTips.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-6 bg-primary/5 border border-primary/20 rounded-xl mb-8"
          >
            <div className="flex items-start gap-3 mb-3">
              <Lightbulb className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
              <h2 className="font-semibold text-primary">Key Tips</h2>
            </div>
            <ul className="space-y-2 ml-8">
              {stroke.keyTips.map((tip, i) => (
                <li key={i} className="text-foreground list-disc">{tip}</li>
              ))}
            </ul>
          </motion.div>
        )}

        {/* Body Sections */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <BodySections sections={stroke.bodySections} />
        </motion.div>

        {/* Common Mistakes */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <CommonMistakes mistakes={stroke.commonMistakes} />
        </motion.div>

        {/* Video Tips */}
        {videoTips.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="mt-12"
          >
            <h2 className="text-2xl font-bold mb-6">Video Tutorials</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {videoTips.map(video => (
                <VideoTipCard key={video._id} video={video} />
              ))}
            </div>
          </motion.div>
        )}

        {/* Related Strokes */}
        {stroke.relatedStrokes && stroke.relatedStrokes.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mt-12"
          >
            <h2 className="text-2xl font-bold mb-6">Related Strokes</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {stroke.relatedStrokes.map(rs => (
                <LocalizedLink key={rs._id} to={`/padel-strokes/${rs.slug}`}>
                  <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                    <CardContent className="p-4">
                      <div className="flex gap-2 mb-2">
                        {rs.category && <Badge variant="secondary" className="text-xs">{rs.category}</Badge>}
                        {rs.difficulty && <Badge variant="outline" className="text-xs">{rs.difficulty}</Badge>}
                      </div>
                      <CardTitle className="text-base mb-1 hover:text-primary transition-colors">{rs.h1}</CardTitle>
                      <p className="text-sm text-muted-foreground line-clamp-2">{rs.shortDescription}</p>
                    </CardContent>
                  </Card>
                </LocalizedLink>
              ))}
            </div>
          </motion.div>
        )}

        {/* Related Rules */}
        {stroke.relatedRules && stroke.relatedRules.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
            className="mt-12"
          >
            <h2 className="text-2xl font-bold mb-6">Related Rules</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {stroke.relatedRules.map(rule => (
                <LocalizedLink key={rule._id} to={`/padel-rules/${rule.slug}`}>
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

        <CTASection cta={stroke.cta} />
      </article>
    </MarketingLayout>
  );
}
