import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { CTASection } from '@/components/sanity/CTASection';
import { VideoTipCard } from '@/components/sanity/VideoTipCard';
import type { VideoTip } from '@/components/sanity/VideoTipCard';
import { motion } from 'framer-motion';
import { ArrowLeft, ExternalLink, MapPin, Globe, User, Instagram, Youtube, Info } from 'lucide-react';
import { sanityClient, COACH_BY_SLUG_QUERY, VIDEO_TIPS_BY_TRAINER_QUERY } from '@/lib/sanity';
import type { SeoFields, CtaFields } from '@/lib/sanity';

interface CoachDetail {
  _id: string;
  name: string;
  slug: string;
  bio: string | null;
  shortTagline: string | null;
  location: string | null;
  languages: string[] | null;
  bestFor: string[] | null;
  isFeatured: boolean | null;
  specialties: string[] | null;
  profileImageUrl: string | null;
  platformProfileUrl: string | null;
  instagramUrl: string | null;
  youtubeUrl: string | null;
  tiktokUrl: string | null;
  websiteUrl: string | null;
  seo: SeoFields | null;
  cta: CtaFields | null;
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.73a8.19 8.19 0 004.76 1.52v-3.4a4.85 4.85 0 01-1-.16z" />
    </svg>
  );
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
        <div className="container mx-auto px-4 py-8 max-w-4xl">
          <div className="flex flex-col md:flex-row gap-8">
            <Skeleton className="h-48 w-48 rounded-2xl flex-shrink-0" />
            <div className="flex-1 space-y-4">
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-4 w-48" />
            </div>
          </div>
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

  const socialLinks = [
    coach.instagramUrl && { href: coach.instagramUrl, icon: Instagram, label: 'Instagram' },
    coach.youtubeUrl && { href: coach.youtubeUrl, icon: Youtube, label: 'YouTube' },
    coach.tiktokUrl && { href: coach.tiktokUrl, icon: TikTokIcon, label: 'TikTok' },
    coach.websiteUrl && { href: coach.websiteUrl, icon: Globe, label: 'Website' },
  ].filter(Boolean) as { href: string; icon: React.ElementType; label: string }[];

  const sameAs = [
    coach.instagramUrl,
    coach.youtubeUrl,
    coach.tiktokUrl,
    coach.websiteUrl,
    coach.platformProfileUrl,
  ].filter(Boolean);

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Person",
    "name": coach.name,
    "description": coach.seo?.metaDescription || coach.bio,
    "url": `https://padeltrainer.ai/padel-coaches/${coach.slug}`,
    ...(coach.profileImageUrl ? { image: coach.profileImageUrl } : {}),
    ...(coach.location ? { "address": { "@type": "PostalAddress", "addressLocality": coach.location } } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(coach.specialties?.length ? { "knowsAbout": coach.specialties } : {}),
  };

  return (
    <MarketingLayout>
      <SEO
        title={coach.seo?.titleTag || `${coach.name} — Padel Coach`}
        description={coach.seo?.metaDescription || coach.shortTagline || coach.bio || `Learn from ${coach.name} on PadelTrainer.ai`}
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

      <article className="container mx-auto px-4 py-8 max-w-4xl">
        <Breadcrumbs items={[
          { label: 'Coaches', href: '/padel-coaches' },
          { label: coach.seo?.breadcrumbLabel || coach.name },
        ]} />

        {/* ── Hero Section ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border bg-card p-6 md:p-8 mb-8"
        >
          <div className="flex flex-col md:flex-row gap-6 md:gap-8 items-start">
            {/* Profile image */}
            <div className="h-40 w-40 md:h-48 md:w-48 rounded-2xl bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
              {coach.profileImageUrl ? (
                <img
                  src={coach.profileImageUrl}
                  alt={coach.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <User className="h-16 w-16 text-muted-foreground" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h1 className="text-3xl md:text-4xl font-bold mb-2">{coach.name}</h1>

              {coach.shortTagline && (
                <p className="text-lg text-muted-foreground italic mb-4">
                  "{coach.shortTagline}"
                </p>
              )}

              {/* Location & languages */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground mb-4">
                {coach.location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="h-4 w-4 text-primary" />
                    {coach.location}
                  </span>
                )}
                {coach.languages && coach.languages.length > 0 && (
                  <span className="flex items-center gap-1.5">
                    <Globe className="h-4 w-4 text-primary" />
                    {coach.languages.join(', ')}
                  </span>
                )}
              </div>

              {/* Social links */}
              {socialLinks.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {socialLinks.map(({ href, icon: Icon, label }) => (
                    <Button key={label} variant="outline" size="sm" asChild>
                      <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        {label}
                      </a>
                    </Button>
                  ))}
                </div>
              )}

              {/* Best for */}
              {coach.bestFor && coach.bestFor.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground">Best for:</span>
                  {coach.bestFor.map(level => (
                    <Badge key={level} variant="default">{level}</Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── About Section ── */}
        {coach.bio && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
          >
            <Card className="mb-8">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-2xl font-bold mb-4">About {coach.name}</h2>
                <p className="text-muted-foreground leading-relaxed whitespace-pre-line">{coach.bio}</p>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* ── Specialties Section ── */}
        {coach.specialties && coach.specialties.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <Card className="mb-8">
              <CardContent className="p-6 md:p-8">
                <h2 className="text-2xl font-bold mb-4">Specialties</h2>
                <div className="flex flex-wrap gap-2">
                  {coach.specialties.map(s => (
                    <Badge key={s} variant="secondary" className="text-sm px-3 py-1">{s}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* ── Platform Profile Link ── */}
        {coach.platformProfileUrl && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="mb-8"
          >
            <Button variant="outline" asChild>
              <a href={coach.platformProfileUrl} className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4" />
                View trainer on PadelTrainer.ai
              </a>
            </Button>
          </motion.div>
        )}

        {/* ── Video Tips ── */}
        {videoTips.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mb-8"
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
