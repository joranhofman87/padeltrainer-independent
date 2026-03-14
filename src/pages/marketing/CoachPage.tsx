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
import { VideoTipCard } from '@/components/sanity/VideoTipCard';
import type { VideoTip } from '@/components/sanity/VideoTipCard';
import { motion } from 'framer-motion';
import { ArrowLeft, ExternalLink, User } from 'lucide-react';
import { sanityClient, COACH_BY_SLUG_QUERY, VIDEO_TIPS_BY_TRAINER_QUERY } from '@/lib/sanity';
import type { SeoFields, CtaFields } from '@/lib/sanity';

interface CoachDetail {
  _id: string;
  name: string;
  slug: string;
  bio: string | null;
  specialties: string[] | null;
  profileImageUrl: string | null;
  platformProfileUrl: string | null;
  seo: SeoFields | null;
  cta: CtaFields | null;
}

export default function CoachPage() {
  const { slug } = useParams<{ slug: string }>();

  const { data: coach, isLoading, error } = useQuery({
    queryKey: ['coach-page', slug],
    queryFn: () => sanityClient.fetch<CoachDetail>(COACH_BY_SLUG_QUERY, { slug }),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  const { data: videoTips = [] } = useQuery({
    queryKey: ['coach-videos', coach?._id],
    queryFn: () => sanityClient.fetch<VideoTip[]>(VIDEO_TIPS_BY_TRAINER_QUERY, { trainerId: coach!._id }),
    enabled: !!coach?._id,
    staleTime: 1000 * 60 * 5,
  });

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Button variant="ghost" asChild>
            <LocalizedLink to="/padel-coaches" className="flex items-center gap-2">
              <ArrowLeft className="h-4 w-4" /> Back to Coaches
            </LocalizedLink>
          </Button>
        </div>
        <div className="container mx-auto px-4 py-8 max-w-3xl">
          <Skeleton className="h-24 w-24 rounded-full mb-4" />
          <Skeleton className="h-10 w-48 mb-4" />
          <Skeleton className="h-4 w-full" />
        </div>
      </MarketingLayout>
    );
  }

  if (error || !coach) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">Coach not found</h1>
          <p className="text-muted-foreground mb-6">This coach page could not be found.</p>
          <Button asChild>
            <LocalizedLink to="/padel-coaches">Back to Coaches</LocalizedLink>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": coach.name,
    "description": coach.seo?.metaDescription || coach.bio,
    "url": `https://padeltrainer.ai/padel-coaches/${coach.slug}`,
    ...(coach.profileImageUrl ? { image: coach.profileImageUrl } : {}),
  };

  return (
    <MarketingLayout>
      <SEO
        title={coach.seo?.titleTag || coach.name}
        description={coach.seo?.metaDescription || coach.bio || `Learn from ${coach.name} on PadelTrainer.ai`}
        url={`/padel-coaches/${slug}`}
        type="article"
        image={coach.profileImageUrl || undefined}
        structuredData={structuredData}
        noIndex={coach.seo?.indexable === false}
      />

      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <LocalizedLink to="/padel-coaches" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" /> Back to Coaches
          </LocalizedLink>
        </Button>
      </div>

      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <Breadcrumbs items={[
          { label: 'Coaches', href: '/padel-coaches' },
          { label: coach.seo?.breadcrumbLabel || coach.name },
        ]} />

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col md:flex-row gap-6 items-start mb-8">
          {/* Profile image */}
          <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
            {coach.profileImageUrl ? (
              <img src={coach.profileImageUrl} alt={coach.name} className="w-full h-full object-cover" />
            ) : (
              <User className="h-12 w-12 text-muted-foreground" />
            )}
          </div>

          <div className="flex-1">
            <h1 className="text-3xl md:text-4xl font-bold mb-3">{coach.name}</h1>

            {coach.specialties && coach.specialties.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {coach.specialties.map(s => (
                  <Badge key={s} variant="secondary">{s}</Badge>
                ))}
              </div>
            )}

            {coach.bio && (
              <p className="text-muted-foreground leading-relaxed mb-4">{coach.bio}</p>
            )}

            {/* Platform profile link – only if present */}
            {coach.platformProfileUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={coach.platformProfileUrl} className="flex items-center gap-2">
                  <ExternalLink className="h-4 w-4" />
                  View trainer on PadelTrainer.ai
                </a>
              </Button>
            )}
          </div>
        </motion.div>

        {/* Video Tips */}
        {videoTips.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <h2 className="text-2xl font-bold mb-6">Videos by {coach.name}</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {videoTips.map(video => (
                <VideoTipCard key={video._id} video={video} />
              ))}
            </div>
          </motion.div>
        )}

        <CTASection cta={coach.cta} />
      </article>
    </MarketingLayout>
  );
}
