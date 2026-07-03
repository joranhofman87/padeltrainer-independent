import { useState } from 'react';
import { useAdminReviews, useUpdateReviewStatus } from '@/hooks/useCourtReviews';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SelectFilter } from '@/components/ui/select-filter';
import { Check, X, Star } from 'lucide-react';
import { format } from 'date-fns';

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
};

export default function AdminCourtReviews() {
  const [filter, setFilter] = useState('pending');
  const { data: reviews = [], isLoading } = useAdminReviews(filter);
  const updateStatus = useUpdateReviewStatus();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Court Reviews</h1>
        <SelectFilter
          value={filter}
          onValueChange={setFilter}
          allLabel="All"
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ]}
          triggerClassName="w-40"
        />
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : reviews.length === 0 ? (
        <p className="text-muted-foreground text-center py-12">No reviews found.</p>
      ) : (
        <div className="space-y-4">
          {reviews.map((review: any) => (
            <div key={review.id} className="border rounded-lg p-4 bg-card space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-foreground">
                    {review.locations?.name} — {review.locations?.city}, {review.locations?.country}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(review.created_at), 'MMM d, yyyy HH:mm')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={statusColors[review.status]}>
                    {review.status}
                  </Badge>
                  <div className="flex items-center gap-1">
                    <Star className="h-4 w-4 fill-primary text-primary" />
                    <span className="font-medium">{review.overall_rating}</span>
                  </div>
                </div>
              </div>

              {/* Rating summary */}
              <div className="grid grid-cols-5 gap-2 text-xs">
                {[
                  ['Surface', review.rating_surface],
                  ['Glass', review.rating_glass],
                  ['Lighting', review.rating_lighting],
                  ['Space', review.rating_space],
                  ['Changing', review.rating_changing_rooms],
                  ['Booking', review.rating_booking],
                  ['Value', review.rating_value],
                  ['Atmosphere', review.rating_atmosphere],
                  ['Parking', review.rating_parking],
                  ['Beginner', review.rating_beginner_friendly],
                ].map(([label, val]) => (
                  <div key={label as string} className="text-center">
                    <p className="text-muted-foreground">{label as string}</p>
                    <p className="font-medium">{val as number}/5</p>
                  </div>
                ))}
              </div>

              {/* Comments */}
              {(review.best_thing || review.improvement) && (
                <div className="text-sm space-y-1">
                  {review.best_thing && (
                    <p><span className="text-muted-foreground">Best:</span> {review.best_thing}</p>
                  )}
                  {review.improvement && (
                    <p><span className="text-muted-foreground">Improve:</span> {review.improvement}</p>
                  )}
                </div>
              )}

              {/* Actions */}
              {review.status === 'pending' && (
                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    onClick={() => updateStatus.mutate({ id: review.id, status: 'approved' })}
                    disabled={updateStatus.isPending}
                  >
                    <Check className="h-4 w-4 mr-1" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => updateStatus.mutate({ id: review.id, status: 'rejected' })}
                    disabled={updateStatus.isPending}
                  >
                    <X className="h-4 w-4 mr-1" /> Reject
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
