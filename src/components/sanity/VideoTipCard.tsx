import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Play, User } from 'lucide-react';
import { parseVideoUrl } from '@/lib/videoEmbed';

export interface VideoTip {
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
  trainer?: { _id: string; name: string; slug: string } | null;
  strokes?: { _id: string; title: string; slug: string }[] | null;
}

interface VideoTipCardProps {
  video: VideoTip;
}

export function VideoTipCard({ video }: VideoTipCardProps) {
  // Derive thumbnail from video URL if not explicitly set
  const embedInfo = video.videoUrl ? parseVideoUrl(video.videoUrl) : null;
  const thumbnail = video.thumbnailUrl || embedInfo?.thumbnailUrl || null;

  return (
    <LocalizedLink to={`/video-tips/${video.slug}`} className="block h-full">
      <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20 overflow-hidden">
        {/* Thumbnail */}
        <div className="aspect-video bg-muted relative group">
          {thumbnail ? (
            <img
              src={thumbnail}
              alt={video.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Play className="h-12 w-12 text-muted-foreground/40" />
            </div>
          )}
          {/* Play overlay */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="h-12 w-12 rounded-full bg-primary/90 flex items-center justify-center">
              <Play className="h-5 w-5 text-primary-foreground fill-current" />
            </div>
          </div>
          {video.platform && (
            <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
              {video.platform}
            </Badge>
          )}
        </div>

        <CardContent className="p-4 space-y-3">
          <h3 className="font-semibold line-clamp-2 text-sm">{video.title}</h3>

          {video.shortSummary && (
            <p className="text-sm text-muted-foreground line-clamp-2">{video.shortSummary}</p>
          )}

          {/* Trainer attribution */}
          {video.trainer && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="h-3 w-3" />
              {video.trainer.name}
            </div>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap">
            {video.skillLevel && (
              <Badge variant="outline" className="text-xs">{video.skillLevel}</Badge>
            )}
            {video.tags?.slice(0, 2).map(tag => (
              <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </LocalizedLink>
  );
}
