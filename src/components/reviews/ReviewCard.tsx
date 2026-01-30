import { useTranslation } from 'react-i18next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StarRating } from './StarRating';
import { format } from 'date-fns';
import type { ReviewWithDetails } from '@/lib/reviews';

interface ReviewCardProps {
  review: ReviewWithDetails;
}

export function ReviewCard({ review }: ReviewCardProps) {
  const { i18n } = useTranslation();
  const isAnonymous = review.is_anonymous;
  
  const displayName = isAnonymous 
    ? 'Anonymous' 
    : (review.profiles?.full_name || 'Player');
  
  const initials = isAnonymous 
    ? '?' 
    : (review.profiles?.full_name?.split(' ').map((n) => n[0]).join('').toUpperCase() || 'P');
  
  const avatarUrl = isAnonymous ? undefined : review.profiles?.avatar_url;

  const getTagName = (tag: { name: string; name_nl: string }) => {
    return i18n.language === 'nl' ? tag.name_nl : tag.name;
  };

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start gap-4">
          <Avatar className="h-10 w-10">
            {!isAnonymous && <AvatarImage src={avatarUrl || undefined} />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="font-medium truncate">
                {displayName}
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {format(new Date(review.created_at), 'MMM d, yyyy')}
              </span>
            </div>
            <StarRating rating={review.rating} size="sm" />
            {review.tags && review.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {review.tags.map(tag => (
                  <Badge key={tag.id} variant="secondary" className="text-xs">
                    {getTagName(tag)}
                  </Badge>
                ))}
              </div>
            )}
            {review.comment && (
              <p className="text-sm text-muted-foreground mt-2">{review.comment}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
