import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { VideoTipCard, type VideoTip } from '@/components/sanity/VideoTipCard';
import { Video, X, ArrowRight } from 'lucide-react';
import { sanityClient, VIDEO_TIPS_LIST_QUERY } from '@/lib/sanity';
import { parseVideoUrl } from '@/lib/videoEmbed';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { useTranslation } from 'react-i18next';
import { MarketingHero, MarketingSection, MarketingFinalCTA } from '@/components/marketing/sections';
import { cn } from '@/lib/utils';

export default function VideoTips() {
  const { t, i18n } = useTranslation('marketing');
  const lang = i18n.language || 'en';

  const { data: videos = [], isLoading } = useQuery({
    queryKey: ['video-tips-list', lang],
    queryFn: () => sanityClient.fetch<VideoTip[]>(VIDEO_TIPS_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const breadcrumbListSD = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('nav.home', 'Home'), item: `${MARKETING_DOMAIN}/${lang}` },
      { '@type': 'ListItem', position: 2, name: t('videoTips.breadcrumbLearn', 'Learn'), item: `${MARKETING_DOMAIN}/${lang}/learn` },
      { '@type': 'ListItem', position: 3, name: t('videoTips.title', 'Video Tips & Tutorials') },
    ],
  };

  const videoObjectsSD = videos.slice(0, 20).map((v) => {
    const embedInfo = v.videoUrl ? parseVideoUrl(v.videoUrl) : null;
    const thumb = v.thumbnailUrl || embedInfo?.thumbnailUrl || undefined;
    return {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: v.title,
      description: v.shortSummary || v.title,
      thumbnailUrl: thumb,
      uploadDate: (v as any).datePublished || undefined,
      contentUrl: v.videoUrl,
      ...(embedInfo?.embedUrl ? { embedUrl: embedInfo.embedUrl } : {}),
      ...(v.trainer ? { author: { '@type': 'Person', name: v.trainer.name } } : {}),
      publisher: {
        '@type': 'Organization',
        name: 'PadelTrainer.ai',
        logo: { '@type': 'ImageObject', url: `${MARKETING_DOMAIN}/favicon.png` },
      },
    };
  });

  const itemListSD =
    videos.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: t('videoTips.title', 'Padel Video Tips & Tutorials'),
          itemListElement: videos.map((v, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: v.title,
            url: `${MARKETING_DOMAIN}/${lang}/video-tips/${v.slug}`,
          })),
        }
      : undefined;

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
      v.strokes?.forEach((s) => strokes.set(s._id, s.title));
      if (v.skillLevel) skills.add(v.skillLevel);
      if (v.trainer) trainers.set(v.trainer._id, v.trainer.name);
      v.tags?.forEach((tag) => tags.add(tag));
    }
    return {
      strokes: Array.from(strokes, ([id, title]) => ({ id, title })).sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
      skills: Array.from(skills).sort(),
      trainers: Array.from(trainers, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      tags: Array.from(tags).sort(),
    };
  }, [videos]);

  const filtered = useMemo(() => {
    return videos.filter((v) => {
      if (selectedStroke && !v.strokes?.some((s) => s._id === selectedStroke)) return false;
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

  const filterChip = (active: boolean) =>
    cn(
      'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
      active ? 'bg-navy-900 text-white' : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
    );

  return (
    <MarketingLayout>
      <SEO
        title={t('videoTips.title', 'Padel Video Tips & Tutorials')}
        description={t('videoTips.metaDescription', 'Watch expert padel video tips covering every stroke and skill level. Filter by technique, trainer, and difficulty to find the perfect tutorial.')}
        url="/video-tips"
        structuredData={structuredData}
      />

      <MarketingHero
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5" />
            {t('videoTips.badge', 'Video Library')}
          </span>
        }
        title={t('videoTips.title', 'Padel Video Tips & Tutorials')}
        subtitle={t('videoTips.subtitle', 'Expert coaching videos to improve every aspect of your game. Filter by stroke, skill level, or trainer.')}
        compact
      />

      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <Breadcrumbs
          items={[
            { label: t('videoTips.breadcrumbLearn', 'Learn'), href: '/learn' },
            { label: t('videoTips.title', 'Video Tips & Tutorials') },
          ]}
        />
      </div>

      <MarketingSection background="default">
        {!isLoading && videos.length > 0 && (
          <div className="mb-8 space-y-4">
            {filterOptions.strokes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-navy-700 mr-1">
                  {t('videoTips.filterStroke', 'Stroke')}:
                </span>
                {filterOptions.strokes.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedStroke(selectedStroke === s.id ? null : s.id)}
                    className={filterChip(selectedStroke === s.id)}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            )}
            {filterOptions.skills.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-navy-700 mr-1">
                  {t('videoTips.filterLevel', 'Level')}:
                </span>
                {filterOptions.skills.map((skill) => (
                  <button
                    key={skill}
                    type="button"
                    onClick={() => setSelectedSkill(selectedSkill === skill ? null : skill)}
                    className={filterChip(selectedSkill === skill)}
                  >
                    {skill}
                  </button>
                ))}
              </div>
            )}
            {filterOptions.trainers.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-navy-700 mr-1">
                  {t('videoTips.filterCoach', 'Coach')}:
                </span>
                {filterOptions.trainers.map((tr) => (
                  <button
                    key={tr.id}
                    type="button"
                    onClick={() => setSelectedTrainer(selectedTrainer === tr.id ? null : tr.id)}
                    className={filterChip(selectedTrainer === tr.id)}
                  >
                    {tr.name}
                  </button>
                ))}
              </div>
            )}
            {filterOptions.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-navy-700 mr-1">
                  {t('videoTips.filterTags', 'Tags')}:
                </span>
                {filterOptions.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                    className={filterChip(selectedTag === tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center text-xs text-navy-600 hover:text-brand-600"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t('videoTips.clearFilters', 'Clear filters')}
              </button>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="aspect-video w-full rounded-2xl" />
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Video className="h-12 w-12 text-navy-400 mx-auto mb-4" />
            <h2 className="font-display text-xl font-bold text-navy-900 mb-2">
              {hasActiveFilters
                ? t('videoTips.noMatch', 'No videos match your filters')
                : t('videoTips.empty', 'No video tips yet')}
            </h2>
            <p className="text-navy-600 mb-4">
              {hasActiveFilters
                ? t('videoTips.adjustFilters', 'Try adjusting your filters to find more videos.')
                : t('videoTips.emptyDescription', 'Check back soon for expert padel coaching videos.')}
            </p>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="pill-ghost text-sm">
                {t('videoTips.clearFilters', 'Clear filters')}
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="text-sm text-navy-600 mb-4">
              {filtered.length} video{filtered.length !== 1 ? 's' : ''}
              {hasActiveFilters ? ` ${t('videoTips.matchingFilters', 'matching your filters')}` : ''}
            </p>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filtered.map((video) => (
                <VideoTipCard key={video._id} video={video} />
              ))}
            </div>
          </>
        )}
      </MarketingSection>

      <MarketingFinalCTA
        title={t('videoTips.wantMore', 'Looking for a specific coach or skill?')}
        body={t('videoTips.wantMoreDescription', 'Browse our trainer directory to find coaches near you or book private sessions.')}
        primaryHref={`/${lang}/trainers`}
        primaryLabel={
          <>
            {t('videoTips.findCoach', 'Find a Coach')}
            <ArrowRight className="ml-2 h-5 w-5" />
          </>
        }
      />
    </MarketingLayout>
  );
}
