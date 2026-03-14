import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { CTASection } from '@/components/sanity/CTASection';
import { motion } from 'framer-motion';
import { ArrowLeft, ExternalLink, User } from 'lucide-react';
import { sanityClient, VIDEO_TIP_BY_SLUG_QUERY } from '@/lib/sanity';
import type { SeoFields, CtaFields } from '@/lib/sanity';
import { parseVideoUrl } from '@/lib/videoEmbed';

interface VideoTipDetail {
  _id: string;
  title: string;
  slug: string;
  videoUrl: string;
  platform: string | null;
  shortSummary: string | null;
  thumbnailUrl: string | null;
  isFeatured: boolean | null;
  skillLevel: string | null;
  tags: string[] | null;
  seo: SeoFields | null;
  cta: CtaFields | null;
  datePublished: string | null;
  dateModified: string | null;
  trainer: { _id: string; name: string; slug: string; profileImageUrl: string | null } | null;
  strokes: { _id: string; title: string; slug: string }[] | null;
}

export default function VideoTipPage() {
  const { slug } = useParams<{ slug: string }>();

  const { data: video, isLoading, error } = useQuery({
    queryKey: ['video-tip', slug],
    queryFn: () => sanityClient.fetch<VideoTipDetail>(VIDEO_TIP_BY_SLUG_QUERY, { slug }),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-8 max-w-3xl">
          <Skeleton className="h-10 w-full mb-4" />
          <Skeleton className="aspect-video w-full mb-4" />
          <Skeleton className="h-4 w-full" />
        </div>
      </MarketingLayout>
    );
  }

  if (error || !video) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">Video not found</h1>
          <p className="text-muted-foreground mb-6">This video could not be found.</p>
          <Button asChild>
            <LocalizedLink to="/padel-strokes">Browse Strokes</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  return (
    <MarketingLayout>
      <SEO
        title={video.seo?.titleTag || video.title}
        description={video.seo?.metaDescription || video.shortSummary || video.title}
        url={`/video-tips/${slug}`}
        type="article"
        image={video.thumbnailUrl || undefined}
        noIndex={video.seo?.indexable === false}
      />

      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <Breadcrumbs items={[
          { label: 'Video Tips' },
          { label: video.seo?.breadcrumbLabel || video.title },
        ]} />

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{video.title}</h1>

          {/* Meta */}
          <div className="flex flex-wrap gap-2 mb-6">
            {video.platform && <Badge variant="secondary">{video.platform}</Badge>}
            {video.skillLevel && <Badge variant="outline">{video.skillLevel}</Badge>}
            {video.tags?.map(tag => <Badge key={tag} variant="outline">{tag}</Badge>)}
          </div>

          {/* Embedded Video Player */}
          {(() => {
            const embedInfo = video.videoUrl ? parseVideoUrl(video.videoUrl) : null;
            if (embedInfo) {
              return (
                <div className="aspect-video bg-muted rounded-xl overflow-hidden mb-6">
                  <iframe
                    src={embedInfo.embedUrl}
                    title={video.title}
                    className="w-full h-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              );
            }
            if (video.thumbnailUrl) {
              return (
                <div className="aspect-video bg-muted rounded-xl overflow-hidden mb-6">
                  <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
                </div>
              );
            }
            return null;
          })()}

          {video.videoUrl && (
            <Button variant="outline" className="mb-6" asChild>
              <a href={video.videoUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Watch on {video.platform || 'external site'}
              </a>
            </Button>
          )}

          {video.shortSummary && (
            <p className="text-lg text-muted-foreground leading-relaxed mb-8">{video.shortSummary}</p>
          )}

          {/* Trainer attribution */}
          {video.trainer && (
            <div className="flex items-center gap-4 p-4 bg-muted/50 rounded-lg mb-8">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                {video.trainer.profileImageUrl ? (
                  <img src={video.trainer.profileImageUrl} alt={video.trainer.name} className="w-full h-full object-cover" />
                ) : (
                  <User className="h-6 w-6 text-muted-foreground" />
                )}
              </div>
              <div>
                <p className="font-semibold">{video.trainer.name}</p>
                <LocalizedLink
                  to={`/padel-coaches/${video.trainer.slug}`}
                  className="text-sm text-primary hover:underline"
                >
                  View coach profile
                </LocalizedLink>
              </div>
            </div>
          )}

          {/* Related strokes */}
          {video.strokes && video.strokes.length > 0 && (
            <div className="mb-8">
              <h2 className="text-xl font-bold mb-3">Related Strokes</h2>
              <div className="flex flex-wrap gap-2">
                {video.strokes.map(s => (
                  <Button key={s._id} variant="outline" size="sm" asChild>
                    <LocalizedLink to={`/padel-strokes/${s.slug}`}>{s.title}</LocalizedLink>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </motion.div>

        <CTASection cta={video.cta} />
      </article>
    </MarketingLayout>
  );
}
