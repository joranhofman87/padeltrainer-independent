import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, GripVertical, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { parseVideoUrl, isValidVideoUrl } from '@/lib/videoEmbed';

interface ProfileVideo {
  id: string;
  video_url: string;
  title: string | null;
  sort_order: number;
}

interface VideoManagerProps {
  trainerProfileId?: string;
  academyProfileId?: string;
}

export function VideoManager({ trainerProfileId, academyProfileId }: VideoManagerProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const [videos, setVideos] = useState<ProfileVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUrl, setNewUrl] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchVideos = async () => {
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
  };

  useEffect(() => {
    fetchVideos();
  }, [trainerProfileId, academyProfileId]);

  const handleAdd = async () => {
    if (!newUrl.trim()) return;

    if (!isValidVideoUrl(newUrl.trim())) {
      toast({
        title: t('error', 'Error'),
        description: t('invalidVideoUrl', 'Please enter a valid YouTube, Vimeo, TikTok, or Instagram URL.'),
        variant: 'destructive',
      });
      return;
    }

    setAdding(true);
    try {
      const insertData: any = {
        video_url: newUrl.trim(),
        title: newTitle.trim() || null,
        sort_order: videos.length,
      };

      if (trainerProfileId) insertData.trainer_profile_id = trainerProfileId;
      if (academyProfileId) insertData.academy_profile_id = academyProfileId;

      const { error } = await supabase.from('profile_videos').insert(insertData);
      if (error) throw error;

      setNewUrl('');
      setNewTitle('');
      await fetchVideos();
      toast({ title: t('videoAdded', 'Video added') });
    } catch (error: any) {
      toast({
        title: t('error', 'Error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('profile_videos').delete().eq('id', id);
    if (error) {
      toast({ title: t('error', 'Error'), description: error.message, variant: 'destructive' });
      return;
    }
    setVideos(videos.filter(v => v.id !== id));
    toast({ title: t('videoRemoved', 'Video removed') });
  };

  const videoInfo = newUrl ? parseVideoUrl(newUrl) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="h-5 w-5" />
          {t('videos', 'Videos')}
        </CardTitle>
        <CardDescription>
          {t('videosDescription', 'Add YouTube, Vimeo, TikTok, or Instagram videos to showcase your coaching')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Existing videos */}
        {videos.length > 0 && (
          <div className="space-y-3">
            {videos.map((video) => {
              const info = parseVideoUrl(video.video_url);
              return (
                <div key={video.id} className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                  <div className="flex-shrink-0">
                    {info?.thumbnailUrl ? (
                      <img
                        src={info.thumbnailUrl}
                        alt={video.title || 'Video'}
                        className="w-20 h-12 object-cover rounded"
                      />
                    ) : (
                      <div className="w-20 h-12 bg-muted-foreground/10 rounded flex items-center justify-center">
                        <Video className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{video.title || info?.platform || 'Video'}</p>
                    <p className="text-xs text-muted-foreground truncate">{video.video_url}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(video.id)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add new video */}
        <div className="space-y-3 pt-2 border-t">
          <div className="space-y-2">
            <Label htmlFor="video-url">{t('videoUrl', 'Video URL')}</Label>
            <Input
              id="video-url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=... or https://instagram.com/reel/..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="video-title">{t('videoTitle', 'Title (optional)')}</Label>
            <Input
              id="video-title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t('videoTitlePlaceholder', 'e.g. Forehand technique')}
            />
          </div>

          {newUrl && videoInfo && (
            <div className="rounded-lg overflow-hidden border">
              {videoInfo.thumbnailUrl && (
                <img
                  src={videoInfo.thumbnailUrl}
                  alt="Video thumbnail"
                  className="w-full h-32 object-cover"
                />
              )}
              <p className="text-xs text-green-600 p-2 bg-green-50 dark:bg-green-900/20">
                ✓ {t('validVideoUrl', 'Valid {{platform}} URL', { platform: videoInfo.platform })}
              </p>
            </div>
          )}

          {newUrl && !videoInfo && (
            <p className="text-xs text-destructive">
              {t('invalidVideoUrl', 'Please enter a valid YouTube, Vimeo, TikTok, or Instagram URL.')}
            </p>
          )}

          <Button
            type="button"
            variant="outline"
            onClick={handleAdd}
            disabled={adding || !newUrl.trim() || !videoInfo}
          >
            <Plus className="h-4 w-4 mr-2" />
            {adding ? t('adding', 'Adding...') : t('addVideo', 'Add Video')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
