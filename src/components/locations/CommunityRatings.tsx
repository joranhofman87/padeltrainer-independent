import { useLocationReviews, useLocationReviewStats } from '@/hooks/useCourtReviews';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Star, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';
import { format } from 'date-fns';

interface CommunityRatingsProps {
  locationId: string;
  locationSlug: string;
}

const CATEGORIES = [
  { key: 'surface', statsKey: 'avg_surface' },
  { key: 'glass', statsKey: 'avg_glass' },
  { key: 'lighting', statsKey: 'avg_lighting' },
  { key: 'space', statsKey: 'avg_space' },
  { key: 'changing_rooms', statsKey: 'avg_changing_rooms' },
  { key: 'booking', statsKey: 'avg_booking' },
  { key: 'value', statsKey: 'avg_value' },
  { key: 'atmosphere', statsKey: 'avg_atmosphere' },
  { key: 'parking', statsKey: 'avg_parking' },
  { key: 'beginner_friendly', statsKey: 'avg_beginner_friendly' },
] as const;

export function CommunityRatings({ locationId, locationSlug }: CommunityRatingsProps) {
  const { t } = useTranslation('marketing');
  const { data: stats } = useLocationReviewStats(locationId);
  const { data: reviews = [] } = useLocationReviews(locationId);

  if (!stats || stats.total_count === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Star className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground mb-4">
            {t('communityRatings.noReviews', 'No community reviews yet. Be the first!')}
          </p>
          <Button asChild aria-label={t('communityRatings.rateThisClub', 'Rate This Club')}>
            <LocalizedLink to={`/playground/rate-my-court?club=${locationSlug}`}>
              {t('communityRatings.rateThisClub', 'Rate This Club')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </LocalizedLink>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Star className="h-5 w-5 text-primary" />
            {t('communityRatings.title', 'Community Ratings')}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-foreground">{stats.avg_overall}</span>
            <div className="text-sm text-muted-foreground">
              <span>/5</span>
              <span className="ml-1">({stats.total_count} {stats.total_count === 1 ? 'review' : 'reviews'})</span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Category breakdown bars */}
        <div className="space-y-3">
          {CATEGORIES.map(({ key, statsKey }) => {
            const value = (stats as any)[statsKey] as number;
            if (!value) return null;
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground w-36 shrink-0">
                  {t(`rateMyCourtPage.categories.${key}`)}
                </span>
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${(value / 5) * 100}%` }}
                  />
                </div>
                <span className="text-sm font-medium w-8 text-right">{value}</span>
              </div>
            );
          })}
        </div>

        {/* Individual reviews */}
        {reviews.length > 0 && (
          <div className="space-y-4 pt-4 border-t">
            {reviews.slice(0, 5).map((review) => (
              <div key={review.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star
                        key={s}
                        className={`h-3.5 w-3.5 ${
                          s <= review.overall_rating
                            ? 'fill-primary text-primary'
                            : 'fill-none text-muted-foreground/30'
                        }`}
                      />
                    ))}
                    <span className="text-sm font-medium ml-1">{review.overall_rating}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(review.created_at), 'MMM d, yyyy')}
                  </span>
                </div>
                {review.best_thing && (
                  <p className="text-sm text-foreground">"{review.best_thing}"</p>
                )}
                {review.player_level && (
                  <Badge variant="outline" className="text-xs">
                    {t(`rateMyCourtPage.levels.${review.player_level}`, review.player_level)}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}

        {/* CTA */}
        <div className="pt-2">
          <Button variant="outline" className="w-full" asChild aria-label={t('communityRatings.rateThisClub', 'Rate This Club')}>
            <LocalizedLink to={`/playground/rate-my-court?club=${locationSlug}`}>
              {t('communityRatings.rateThisClub', 'Rate This Club')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </LocalizedLink>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
