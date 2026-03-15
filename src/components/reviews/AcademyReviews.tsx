import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { StarRating } from './StarRating';
import { getAcademyAggregatedReviews, type ReviewWithDetails } from '@/lib/reviews';
import { format } from 'date-fns';

interface AcademyReviewsProps {
  academyId: string;
}

export function AcademyReviews({ academyId }: AcademyReviewsProps) {
  const { t, i18n } = useTranslation(['common']);
  const [reviews, setReviews] = useState<ReviewWithDetails[]>([]);
  const [average, setAverage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchReviews() {
      const result = await getAcademyAggregatedReviews(academyId);
      if (result.data) {
        setReviews(result.data);
        setAverage(result.average);
      }
      setLoading(false);
    }
    fetchReviews();
  }, [academyId]);

  const getTagName = (tag: { name: string; name_nl: string }) => {
    return i18n.language === 'nl' ? tag.name_nl : tag.name;
  };

  if (loading) {
    return null;
  }

  if (reviews.length === 0) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold flex items-center gap-2">
          <MessageSquare className="h-6 w-6 text-primary" />
          {t('reviews', { count: reviews.length })}
        </h2>
        <div className="flex items-center gap-4">
          {average && (
            <div className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
              <span className="text-lg font-semibold">{average}</span>
              <span className="text-muted-foreground">({reviews.length})</span>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {reviews.slice(0, 6).map(review => {
          const isAnonymous = review.is_anonymous;
          const displayName = isAnonymous
            ? 'Anonymous'
            : (review.profiles?.full_name || 'Player');
          const initials = isAnonymous
            ? '?'
            : (review.profiles?.full_name?.split(' ').map((n) => n[0]).join('').toUpperCase() || 'P');
          const avatarUrl = isAnonymous ? undefined : review.profiles?.avatar_url;

          return (
            <Card key={review.id}>
              <CardContent className="pt-4">
                <div className="flex items-start gap-4">
                  <Avatar className="h-10 w-10">
                    {!isAnonymous && <AvatarImage src={avatarUrl || undefined} alt={displayName} />}
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{displayName}</span>
                        {review.trainer_name && (
                          <span className="text-xs text-muted-foreground truncate">
                            via {review.trainer_name}
                          </span>
                        )}
                      </div>
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
                      <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                        {review.comment}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {reviews.length > 6 && (
        <p className="text-center text-sm text-muted-foreground">
          {t('common:viewAll', 'View all')} ({reviews.length - 6} more)
        </p>
      )}
    </div>
  );
}
