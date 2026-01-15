import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { StarRating } from './StarRating';
import { format } from 'date-fns';
import type { ReviewWithDetails } from '@/lib/reviews';

interface ReviewCardProps {
  review: ReviewWithDetails;
}

export function ReviewCard({ review }: ReviewCardProps) {
  const initials = review.profiles?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'P';

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-start gap-4">
          <Avatar className="h-10 w-10">
            <AvatarImage src={review.profiles?.avatar_url || undefined} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="font-medium truncate">
                {review.profiles?.full_name || 'Anonymous'}
              </span>
              <span className="text-xs text-muted-foreground shrink-0">
                {format(new Date(review.created_at), 'MMM d, yyyy')}
              </span>
            </div>
            <StarRating rating={review.rating} size="sm" />
            {review.comment && (
              <p className="text-sm text-muted-foreground mt-2">{review.comment}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
