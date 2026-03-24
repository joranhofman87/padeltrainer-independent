import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BookOpen, Zap, Video, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LocalizedLink } from '@/components/LocalizedLink';
import { ProfileFullWidthSection } from '@/components/profiles';
import { sanityClient, STROKES_LIST_QUERY, VIDEO_TIPS_LIST_QUERY } from '@/lib/sanity';
import { LEARNING_ARTICLES_LIST_QUERY } from '@/lib/learningArticles';
import type { LearningArticleSummary } from '@/lib/learningArticles';
import { VideoTipCard, type VideoTip } from '@/components/sanity/VideoTipCard';

interface StrokeListItem {
  _id: string;
  title: string;
  slug: string;
  h1: string | null;
  shortDescription: string | null;
  category: string | null;
  difficulty: string | null;
}

interface LocationLearnSectionProps {
  lang: string;
}

export function LocationLearnSection({ lang }: LocationLearnSectionProps) {
  const { t } = useTranslation('common');

  const { data: articles = [] } = useQuery({
    queryKey: ['learn-articles-location', lang],
    queryFn: () => sanityClient.fetch<LearningArticleSummary[]>(LEARNING_ARTICLES_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const { data: strokes = [] } = useQuery({
    queryKey: ['strokes-location', lang],
    queryFn: () => sanityClient.fetch<StrokeListItem[]>(STROKES_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const { data: videos = [] } = useQuery({
    queryKey: ['video-tips-location', lang],
    queryFn: () => sanityClient.fetch<VideoTip[]>(VIDEO_TIPS_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const topArticles = articles.slice(0, 6);
  const topStrokes = strokes.slice(0, 6);
  const topVideos = videos.slice(0, 4);

  // Don't render if no content at all
  if (topArticles.length === 0 && topStrokes.length === 0 && topVideos.length === 0) {
    return null;
  }

  const difficultyColor = (d: string | null) => {
    if (!d) return 'secondary' as const;
    if (d.toLowerCase().includes('beginner')) return 'default' as const;
    if (d.toLowerCase().includes('advanced')) return 'destructive' as const;
    return 'secondary' as const;
  };

  return (
    <ProfileFullWidthSection>
      <div className="space-y-8">
        <div className="flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-semibold">{t('locations.learnPadel')}</h2>
        </div>

        {/* Learning Articles */}
        {topArticles.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium">{t('locations.topArticles')}</h3>
              <LocalizedLink to="/learn" className="text-sm text-primary hover:underline flex items-center gap-1">
                {t('locations.viewAllArticles')} <ArrowRight className="h-3 w-3" />
              </LocalizedLink>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {topArticles.map((article) => (
                <LocalizedLink key={article._id} to={`/learn/${article.slug}`} className="block">
                  <Card className="h-full hover:shadow-md transition-shadow hover:border-primary/20">
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center gap-2">
                        {article.pageType === 'hub' && (
                          <Badge variant="secondary" className="text-xs">Hub</Badge>
                        )}
                        {article.skillLevel && (
                          <Badge variant="outline" className="text-xs">{article.skillLevel}</Badge>
                        )}
                      </div>
                      <h4 className="font-semibold text-sm line-clamp-2">{article.h1 || article.title}</h4>
                      {article.intro && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{article.intro}</p>
                      )}
                    </CardContent>
                  </Card>
                </LocalizedLink>
              ))}
            </div>
          </div>
        )}

        {/* Strokes */}
        {topStrokes.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                {t('locations.topStrokes')}
              </h3>
              <LocalizedLink to="/padel-strokes" className="text-sm text-primary hover:underline flex items-center gap-1">
                {t('locations.viewAllStrokes')} <ArrowRight className="h-3 w-3" />
              </LocalizedLink>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {topStrokes.map((stroke) => (
                <LocalizedLink key={stroke._id} to={`/padel-strokes/${stroke.slug}`} className="block">
                  <Card className="h-full hover:shadow-md transition-shadow hover:border-primary/20">
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center gap-2">
                        {stroke.category && (
                          <Badge variant="outline" className="text-xs">{stroke.category}</Badge>
                        )}
                        {stroke.difficulty && (
                          <Badge variant={difficultyColor(stroke.difficulty)} className="text-xs">{stroke.difficulty}</Badge>
                        )}
                      </div>
                      <h4 className="font-semibold text-sm">{stroke.h1 || stroke.title}</h4>
                      {stroke.shortDescription && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{stroke.shortDescription}</p>
                      )}
                    </CardContent>
                  </Card>
                </LocalizedLink>
              ))}
            </div>
          </div>
        )}

        {/* Video Tips */}
        {topVideos.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium flex items-center gap-2">
                <Video className="h-4 w-4 text-primary" />
                {t('locations.topVideos')}
              </h3>
              <LocalizedLink to="/video-tips" className="text-sm text-primary hover:underline flex items-center gap-1">
                {t('locations.viewAllVideos')} <ArrowRight className="h-3 w-3" />
              </LocalizedLink>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {topVideos.map((video) => (
                <VideoTipCard key={video._id} video={video} />
              ))}
            </div>
          </div>
        )}
      </div>
    </ProfileFullWidthSection>
  );
}
