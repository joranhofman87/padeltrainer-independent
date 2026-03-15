import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { VideoTipCard, type VideoTip } from '@/components/sanity/VideoTipCard';
import { motion } from 'framer-motion';
import { Video, X } from 'lucide-react';
import { sanityClient, VIDEO_TIPS_LIST_QUERY } from '@/lib/sanity';

export default function VideoTips() {
  const { data: videos = [], isLoading } = useQuery({
    queryKey: ['video-tips-list'],
    queryFn: () => sanityClient.fetch<VideoTip[]>(VIDEO_TIPS_LIST_QUERY),
    staleTime: 1000 * 60 * 10,
  });

  const itemListStructuredData = videos.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Padel Video Tips & Tutorials",
    "itemListElement": videos.map((v, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": v.title,
      "url": `https://padeltrainer.ai/video-tips/${v.slug}`,
    })),
  } : undefined;

  const [selectedStroke, setSelectedStroke] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [selectedTrainer, setSelectedTrainer] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Extract unique filter values
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

  // Filter videos
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
        title="Padel Video Tips & Tutorials"
        description="Watch expert padel video tips covering every stroke and skill level. Filter by technique, trainer, and difficulty to find the perfect tutorial."
        url="/video-tips"
      />

      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary rounded-full px-4 py-1.5 text-sm font-medium mb-6">
              <Video className="h-4 w-4" />
              Video Library
            </div>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Padel Video Tips & Tutorials</h1>
            <p className="text-xl text-muted-foreground">
              Expert coaching videos to improve every aspect of your game. Filter by stroke, skill level, or trainer.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Filters + Content */}
      <section className="py-12">
        <div className="container mx-auto px-4">
          {/* Filters */}
          {!isLoading && videos.length > 0 && (
            <div className="mb-8 space-y-4">
              {/* Stroke filter */}
              {filterOptions.strokes.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">Stroke:</span>
                  {filterOptions.strokes.map(s => (
                    <Badge
                      key={s.id}
                      variant={selectedStroke === s.id ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => setSelectedStroke(selectedStroke === s.id ? null : s.id)}
                    >
                      {s.title}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Skill level filter */}
              {filterOptions.skills.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">Level:</span>
                  {filterOptions.skills.map(skill => (
                    <Badge
                      key={skill}
                      variant={selectedSkill === skill ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => setSelectedSkill(selectedSkill === skill ? null : skill)}
                    >
                      {skill}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Trainer filter */}
              {filterOptions.trainers.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">Coach:</span>
                  {filterOptions.trainers.map(t => (
                    <Badge
                      key={t.id}
                      variant={selectedTrainer === t.id ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => setSelectedTrainer(selectedTrainer === t.id ? null : t.id)}
                    >
                      {t.name}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Tag filter */}
              {filterOptions.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground mr-1">Tags:</span>
                  {filterOptions.tags.map(tag => (
                    <Badge
                      key={tag}
                      variant={selectedTag === tag ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Clear filters */}
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                  <X className="h-3.5 w-3.5 mr-1" />
                  Clear filters
                </Button>
              )}
            </div>
          )}

          {/* Grid */}
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
                {hasActiveFilters ? 'No videos match your filters' : 'No video tips yet'}
              </h2>
              <p className="text-muted-foreground mb-4">
                {hasActiveFilters ? 'Try adjusting your filters to find more videos.' : 'Check back soon for expert padel coaching videos.'}
              </p>
              {hasActiveFilters && (
                <Button variant="outline" onClick={clearFilters}>Clear filters</Button>
              )}
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                {filtered.length} video{filtered.length !== 1 ? 's' : ''}
                {hasActiveFilters ? ' matching your filters' : ''}
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
    </MarketingLayout>
  );
}
