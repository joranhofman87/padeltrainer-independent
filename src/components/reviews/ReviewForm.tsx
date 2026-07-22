import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StarRating } from './StarRating';
import { ReviewTagSelector } from './ReviewTagSelector';
import { createReviewWithTags } from '@/lib/reviews';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';

interface ReviewFormProps {
  bookingId: string;
  playerId: string;
  trainerId: string;
  trainerName: string;
  // trainerEmail / playerName / lessonTitle used to exist ONLY to address the client-side
  // review email. The trigger composes that server-side from the review row, so passing a
  // recipient in from the browser is no longer needed — and shouldn't be: a client-supplied
  // recipient address is exactly the sort of thing that should not decide where mail goes.
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function ReviewForm({
  bookingId,
  playerId,
  trainerId,
  trainerName,
  onSuccess,
  onCancel,
}: ReviewFormProps) {
  const { toast } = useToast();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (rating === 0) {
      toast({
        title: 'Rating required',
        description: 'Please select a star rating',
        variant: 'destructive',
      });
      return;
    }

    setSubmitting(true);
    const { error } = await createReviewWithTags(
      bookingId,
      playerId,
      trainerId,
      rating,
      selectedTags,
      comment || undefined,
      isAnonymous
    );

    if (error) {
      toast({
        title: 'Error',
        description: getFriendlyErrorMessage(error, 'Could not submit your review. Please try again.'),
        variant: 'destructive',
      });
    } else {
      toast({
        title: 'Review submitted',
        description: 'Thank you for your feedback!',
      });
      
      // The trainer's notification is enqueued SERVER-SIDE by trg_notify_review_received
      // (AFTER INSERT on reviews → review_received_trainer). The legacy client-side
      // send-email call that used to live here was a DUPLICATE of that trigger: both fired
      // for every review. It was invisible while the outbox never delivered; PR 10a fixed
      // delivery, which would have made the next review send two identical emails.
      
      onSuccess?.();
    }
    setSubmitting(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rate your lesson</CardTitle>
        <CardDescription>How was your session with {trainerName}?</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Rating</Label>
            <StarRating
              rating={rating}
              size="lg"
              interactive
              onChange={setRating}
            />
          </div>

          <ReviewTagSelector
            selectedTags={selectedTags}
            onChange={setSelectedTags}
          />

          <div className="space-y-2">
            <Label htmlFor="comment">Comment (optional)</Label>
            <Textarea
              id="comment"
              placeholder="Share your experience..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="anonymous">Post anonymously</Label>
              <p className="text-xs text-muted-foreground">
                Your name will be hidden from other players
              </p>
            </div>
            <Switch
              id="anonymous"
              checked={isAnonymous}
              onCheckedChange={setIsAnonymous}
            />
          </div>

          <div className="flex gap-3 pt-2">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={submitting || rating === 0} className="flex-1">
              {submitting ? 'Submitting...' : 'Submit Review'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
