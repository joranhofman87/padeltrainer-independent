import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { LocalizedLink } from '@/components/LocalizedLink';
import { VideoTipCard, type VideoTip } from '@/components/sanity/VideoTipCard';
import { motion } from 'framer-motion';
import { Video, X, ArrowRight } from 'lucide-react';
import { sanityClient, VIDEO_TIPS_LIST_QUERY } from '@/lib/sanity';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { useTranslation } from 'react-i18next';

export default function VideoTips() {
  const { t, i18n } = useTranslation('marketing');
  const lang = i18n.language || 'en';

  const { data: videos = [], isLoading } = useQuery({
    queryKey: ['video-tips-list', lang],
    queryFn: () => sanityClient.fetch<VideoTip[]>(VIDEO_TIPS_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const breadcrumbListSD = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": t('nav.home', 'Home'), "item": `${MARKETING_DOMAIN}/${lang}` },
      { "@type": "ListItem", "position": 2, "name": t('videoTips.breadcrumbLearn', 'Learn'), "item": `${MARKETING_DOMAIN}/${lang}/learn` },
      { "@type": "ListItem", "position": 3, "name": t('videoTips.title', 'Video Tips & Tutorials') },
    ],
  };

  const videoObjectsSD = videos.slice(0, 20).map(v => ({
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": v.title,
    "description": v.shortSummary || v.title,
    "thumbnailUrl": v.thumbnailUrl || undefined,
    "uploadDate": (v as any).datePublished || undefined,
    "contentUrl": v.videoUrl,
    ...(v.trainer ? { "author": { "@type": "Person", "name": v.trainer.name } } : {}),
  }));

  const itemListSD = videos.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('videoTips.title', 'Padel Video Tips & Tutorials'),
    "itemListElement": videos.map((v, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": v.title,
      "url": `${MARKETING_DOMAIN}/${lang}/video-tips/${v.slug}`,
    })),
  } : undefined;

  const structuredData = [breadcrumbListSD, ...(itemListSD ? [itemListSD] : []), ...videoObjectsSD];

  const [selectedStroke, setSelectedStroke] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [selectedTrainer, setSelectedTrainer] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const filterOptions = useMemo(() => {
    const strokes = new Map<string, string>();
    const skills = new Set<string>();
    const trainers = new Map<string, string>();
    const tags = new Set<string>();
    for (const v of videos) {
      v.strokes?.forEach(s => strokes.set(s._id, s.title));
      if (v.skillLevel) skills.add(v.skillLevel);
      if (v.trainer) trainers.set(v.trainer._id, v.trainer.name);
      v.tags?.forEach(t => tags.add(t));
    }
    return {
      strokes: Array.from(strokes, ([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title)),
      skills: Array.from(skills).sort(),
      trainers: Array.from(trainers, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      tags: Array.from(tags).sort(),
    };
  }, [videos]);

  const filtered = useMemo(() => {
    return videos.filter(v => {
      if (selectedStroke && !v.strokes?.some(s => s._id === selectedStroke)) return false;
      if (selectedSkill && v.skillLevel !== selectedSkill) return false;
      if (selectedTrainer && v.trainer?._id !== selectedTrainer) return false;
      if (selectedTag && !v.tags?.includes(selectedTag)) return false;
      return true;
    });
  }, [videos, selectedStroke, selectedSkill, selectedTrainer, selectedTag]);

  const hasActiveFilters = selectedStroke || selectedSkill || selectedTrainer || selectedTag;

  const clearFilters = () => {
    setSelectedStroke(null);
    setSelectedSkill(null);
    setSelectedTrainer(null);
    setSelectedTag(null);
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('videoTips.title', 'Padel Video Tips & Tutorials')}
        description={t('videoTips.metaDescription', 'Watch expert padel video tips covering every stroke and skill level. Filter by technique, trainer, and difficulty to find the perfect tutorial.')}
        url="/video-tips"
        structuredData={structuredData}
      />

      {/* Hero */}
      <section className="py-16 bg-background">
        <div className="container mx-auto px-4">
          <Breadcrumbs items={[
            { label: t('videoTips.breadcrumbLearn', 'Learn'), href: '/learn' },
            { label: t('videoTips.title', 'Video Tips & Tutorials') },
          ]} />
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary rounded-full px-4 py-1.5 text-sm font-medium mb-6">
              <Video className="h-4 w-4" />
              {t('videoTips.badge', 'Video Library')}
            </div>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('videoTips.title', 'Padel Video Tips & Tutorials')}</h1>
            <p className="text-xl text-muted-foreground mb-6">
              {t('videoTips.subtitle', 'Expert coaching videos to improve every aspect of your game. Filter by stroke, skill level, or trainer.')}
            </p>
            <p className="text-base text-muted-foreground max-w-2xl mx-auto">
              {t('videoTips.introText', 'Learn from experienced padel coaches through short, focused video lessons. Our coaches break down technique, strategy, and game-winning tactics to help you improve faster. Browse by coach to follow your favorite instructors.')}
            </p>
          </motion.div>
        </div>
      </section>

      {/* Filters + Content */}
      <section className="py-12">
        <div className="container mx-auto px-4">
          {!isLoading && videos.length > 0 && (
            <div className="mb-8 space-y-4">
              {filterOptions.strokes.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">{t('videoTips.filterStroke', 'Stroke')}:</span>
                  {filterOptions.strokes.map(s => (
                    <Badge key={s.id} variant={selectedStroke === s.id ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setSelectedStroke(selectedStroke === s.id ? null : s.id)}>
                      {s.title}
                    </Badge>
                  ))}
                </div>
              )}
              {filterOptions.skills.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">{t('videoTips.filterLevel', 'Level')}:</span>
                  {filterOptions.skills.map(skill => (
                    <Badge key={skill} variant={selectedSkill === skill ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setSelectedSkill(selectedSkill === skill ? null : skill)}>
                      {skill}
                    </Badge>
                  ))}
                </div>
              )}
              {filterOptions.trainers.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">{t('videoTips.filterCoach', 'Coach')}:</span>
                  {filterOptions.trainers.map(tr => (
                    <Badge key={tr.id} variant={selectedTrainer === tr.id ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setSelectedTrainer(selectedTrainer === tr.id ? null : tr.id)}>
                      {tr.name}
                    </Badge>
                  ))}
                </div>
              )}
              {filterOptions.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">{t('videoTips.filterTags', 'Tags')}:</span>
                  {filterOptions.tags.map(tag => (
                    <Badge key={tag} variant={selectedTag === tag ? 'default' : 'outline'} className="cursor-pointer" onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}>
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                  <X className="h-3.5 w-3.5 mr-1" />
                  {t('videoTips.clearFilters', 'Clear filters')}
                </Button>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <div key={i} className="space-y-3">
                  <Skeleton className="aspect-video w-full rounded-lg" />
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <Video className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">
                {hasActiveFilters ? t('videoTips.noMatch', 'No videos match your filters') : t('videoTips.empty', 'No video tips yet')}
              </h2>
              <p className="text-muted-foreground mb-4">
                {hasActiveFilters ? t('videoTips.adjustFilters', 'Try adjusting your filters to find more videos.') : t('videoTips.emptyDescription', 'Check back soon for expert padel coaching videos.')}
              </p>
              {hasActiveFilters && (
                <Button variant="outline" onClick={clearFilters}>{t('videoTips.clearFilters', 'Clear filters')}</Button>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                {filtered.length} video{filtered.length !== 1 ? 's' : ''}
                {hasActiveFilters ? ` ${t('videoTips.matchingFilters', 'matching your filters')}` : ''}
              </p>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filtered.map(video => (
                  <VideoTipCard key={video._id} video={video} />
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Want More CTA */}
      <section className="py-12 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-xl mx-auto" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-2xl font-bold mb-4">{t('videoTips.wantMore', 'Looking for a specific coach or skill?')}</h2>
            <p className="text-muted-foreground mb-6">{t('videoTips.wantMoreDescription', 'Browse our trainer directory to find coaches near you or book private sessions.')}</p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button asChild>
                <LocalizedLink to="/trainers" className="flex items-center gap-2">
                  {t('videoTips.findCoach', 'Find a Coach')}
                  <ArrowRight className="h-4 w-4" />
                </LocalizedLink>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
