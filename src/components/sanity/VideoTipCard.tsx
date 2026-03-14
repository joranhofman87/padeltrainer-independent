import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LocalizedLink } from '@/components/LocalizedLink';
import { ExternalLink, Play, User } from 'lucide-react';

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
  return (
    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20 overflow-hidden">
      {/* Thumbnail */}
      <div className="aspect-video bg-muted relative group">
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Play className="h-12 w-12 text-muted-foreground/40" />
          </div>
        )}
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
          <LocalizedLink
            to={`/padel-coaches/${video.trainer.slug}`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <User className="h-3 w-3" />
            {video.trainer.name}
          </LocalizedLink>
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

        {/* Watch button */}
        {video.videoUrl && (
          <Button variant="outline" size="sm" className="w-full" asChild>
            <a href={video.videoUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Watch
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
