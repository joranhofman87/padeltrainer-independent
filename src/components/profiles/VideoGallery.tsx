import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabaseClient';
import { parseVideoUrl } from '@/lib/videoEmbed';

interface ProfileVideo {
  id: string;
  video_url: string;
  title: string | null;
  sort_order: number;
}

interface VideoGalleryProps {
  trainerProfileId?: string;
  academyProfileId?: string;
}

export function VideoGallery({ trainerProfileId, academyProfileId }: VideoGalleryProps) {
  const { t } = useTranslation('common');
  const [videos, setVideos] = useState<ProfileVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeVideo, setActiveVideo] = useState<string | null>(null);

  useEffect(() => {
    async function fetchVideos() {
      let query = supabase
        .from('profile_videos')
        .select('id, video_url, title, sort_order')
        .order('sort_order', { ascending: true });

      if (trainerProfileId) {
        query = query.eq('trainer_profile_id', trainerProfileId);
      } else if (academyProfileId) {
        query = query.eq('academy_profile_id', academyProfileId);
      } else {
        setLoading(false);
        return;
      }

      const { data } = await query;
      setVideos(data || []);
      setLoading(false);
    }

    fetchVideos();
  }, [trainerProfileId, academyProfileId]);

  if (loading || videos.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="h-5 w-5 text-primary" />
          {t('videos', 'Videos')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={videos.length === 1 ? '' : 'grid grid-cols-1 md:grid-cols-2 gap-4'}>
          {videos.map((video) => {
            const info = parseVideoUrl(video.video_url);
            if (!info) return null;

            const isInstagram = info.platform === 'instagram';

            return (
              <div key={video.id} className="space-y-2">
                {video.title && (
                  <p className="text-sm font-medium">{video.title}</p>
                )}
                <div className={`rounded-lg overflow-hidden bg-muted ${isInstagram ? 'aspect-[4/5]' : 'aspect-video'}`}>
                  <iframe
                    src={info.embedUrl}
                    className="w-full h-full border-0"
                    allow="fullscreen; autoplay; encrypted-media"
                    allowFullScreen
                    loading="lazy"
                    scrolling={isInstagram ? 'no' : undefined}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
