import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StarRating } from './StarRating';
import { ReviewCard } from './ReviewCard';
import { getTrainerReviews, getTrainerAverageRating, type ReviewWithDetails } from '@/lib/reviews';
import { MessageSquare } from 'lucide-react';

interface TrainerReviewsProps {
  trainerId: string;
}

export function TrainerReviews({ trainerId }: TrainerReviewsProps) {
  const [reviews, setReviews] = useState<ReviewWithDetails[]>([]);
  const [averageRating, setAverageRating] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchReviews() {
      setLoading(true);
      const [reviewsRes, ratingRes] = await Promise.all([
        getTrainerReviews(trainerId),
        getTrainerAverageRating(trainerId),
      ]);

      if (reviewsRes.data) {
        setReviews(reviewsRes.data);
      }
      setAverageRating(ratingRes.average);
      setReviewCount(ratingRes.count);
      setLoading(false);
    }

    fetchReviews();
  }, [trainerId]);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-muted rounded w-1/3"></div>
            <div className="h-20 bg-muted rounded"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            Reviews
          </div>
          {averageRating !== null && (
            <div className="flex items-center gap-2">
              <StarRating rating={averageRating} size="sm" showValue />
              <span className="text-sm text-muted-foreground">
                ({reviewCount} {reviewCount === 1 ? 'review' : 'reviews'})
              </span>
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {reviews.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No reviews yet</p>
            <p className="text-sm">Be the first to review this trainer!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
