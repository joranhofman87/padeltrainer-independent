import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StarRating } from "@/components/reviews/StarRating";
import { ReviewTagSelector } from "@/components/reviews/ReviewTagSelector";
import { Loader2, Plus, Star, Trash2 } from "lucide-react";
import { logger } from "@/lib/logger";
import { format } from "date-fns";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import type { ReviewWithDetails, ReviewTag } from "@/lib/reviews";

interface AdminTrainerReviewsTabProps {
  trainerId: string;
  trainerName: string;
}

export function AdminTrainerReviewsTab({ trainerId, trainerName }: AdminTrainerReviewsTabProps) {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<ReviewWithDetails[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  
  // Add review form state
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [reviewerName, setReviewerName] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch reviews
  const fetchReviews = async () => {
    setIsLoading(true);
    try {
      // Get all reviews for this trainer
      const { data: reviewsData, error } = await supabase
        .from("reviews")
        .select("*")
        .eq("trainer_id", trainerId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      if (!reviewsData || reviewsData.length === 0) {
        setReviews([]);
        return;
      }

      // Get player profiles
      const playerIds = [...new Set(reviewsData.map(r => r.player_id))];
      const { data: profiles } = await supabase
        .from("profiles_public")
        .select("id, full_name, avatar_url")
        .in("id", playerIds);

      // Get tag selections
      const reviewIds = reviewsData.map(r => r.id);
      const { data: tagSelections } = await supabase
        .from("review_tag_selections")
        .select("review_id, tag_id")
        .in("review_id", reviewIds);

      // Get tags
      const tagIds = [...new Set(tagSelections?.map(ts => ts.tag_id) || [])];
      const { data: tags } = tagIds.length > 0
        ? await supabase.from("review_tags").select("*").in("id", tagIds)
        : { data: [] };

      const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);
      const tagMap = new Map((tags as ReviewTag[])?.map(t => [t.id, t]) || []);

      // Group tags by review
      const reviewTagsMap = new Map<string, ReviewTag[]>();
      tagSelections?.forEach(ts => {
        const tag = tagMap.get(ts.tag_id);
        if (tag) {
          const existing = reviewTagsMap.get(ts.review_id) || [];
          existing.push(tag);
          reviewTagsMap.set(ts.review_id, existing);
        }
      });

      const reviewsWithDetails: ReviewWithDetails[] = reviewsData.map(review => ({
        ...review,
        profiles: profileMap.get(review.player_id) || undefined,
        tags: reviewTagsMap.get(review.id) || [],
      }));

      setReviews(reviewsWithDetails);
    } catch (error) {
      logger.error("Error fetching reviews", error instanceof Error ? error : new Error(String(error)), { component: 'AdminTrainerReviewsTab' });
      toast({
        title: "Error",
        description: "Failed to load reviews",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchReviews();
  }, [trainerId]);

  // Calculate average rating
  const averageRating = reviews.length > 0
    ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
    : 0;

  // Handle add review
  const handleAddReview = async () => {
    if (rating === 0) {
      toast({
        title: "Rating required",
        description: "Please select a star rating",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // For admin-created reviews, we'll create a "virtual" booking ID
      // and use a system player ID (or the admin's profile ID)
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Get admin's profile ID
      const { data: adminProfile } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", user.id)
        .single();

      if (!adminProfile) throw new Error("Admin profile not found");

      // Create a virtual booking ID for admin-created reviews
      const virtualBookingId = crypto.randomUUID();

      // Create the review
      const { data: review, error: reviewError } = await supabase
        .from("reviews")
        .insert({
          booking_id: virtualBookingId,
          player_id: adminProfile.id, // Admin's profile ID
          trainer_id: trainerId,
          rating,
          comment: comment || null,
          is_public: true,
          is_anonymous: isAnonymous,
          reviewer_name: !isAnonymous && reviewerName ? reviewerName : null,
        })
        .select()
        .single();

      if (reviewError) throw reviewError;

      // Add tag selections
      if (selectedTags.length > 0 && review) {
        const tagSelections = selectedTags.map(tagId => ({
          review_id: review.id,
          tag_id: tagId,
        }));

        await supabase.from("review_tag_selections").insert(tagSelections);
      }

      toast({
        title: "Review added",
        description: "The review has been added successfully",
      });

      // Reset form and refresh
      setRating(5);
      setComment("");
      setSelectedTags([]);
      setReviewerName("");
      setIsAnonymous(true);
      setShowAddForm(false);
      fetchReviews();
    } catch (error: any) {
      logger.error("Error adding review", error instanceof Error ? error : new Error(String(error)), { component: 'AdminTrainerReviewsTab' });
      toast({
        title: "Error",
        description: error.message || "Failed to add review",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle delete review
  const handleDeleteReview = async (reviewId: string) => {
    try {
      // First delete tag selections
      await supabase
        .from("review_tag_selections")
        .delete()
        .eq("review_id", reviewId);

      // Then delete the review
      const { error } = await supabase
        .from("reviews")
        .delete()
        .eq("id", reviewId);

      if (error) throw error;

      toast({
        title: "Review deleted",
        description: "The review has been deleted",
      });

      fetchReviews();
    } catch (error: any) {
      logger.error("Error deleting review", error instanceof Error ? error : new Error(String(error)), { component: 'AdminTrainerReviewsTab' });
      toast({
        title: "Error",
        description: error.message || "Failed to delete review",
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 fill-yellow-400 text-yellow-400" />
          <span className="font-medium">{averageRating || "-"}</span>
          <span className="text-muted-foreground">
            ({reviews.length} {reviews.length === 1 ? "review" : "reviews"})
          </span>
        </div>
        <Button
          size="sm"
          variant={showAddForm ? "outline" : "default"}
          onClick={() => setShowAddForm(!showAddForm)}
        >
          <Plus className="h-4 w-4 mr-1" />
          {showAddForm ? "Cancel" : "Add Review"}
        </Button>
      </div>

      {/* Add Review Form */}
      {showAddForm && (
        <Card>
          <CardContent className="pt-4 space-y-4">
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
              <Label htmlFor="comment">Comment</Label>
              <Textarea
                id="comment"
                placeholder="Write a review..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="anonymous">Post as anonymous</Label>
                  <p className="text-xs text-muted-foreground">
                    Hide reviewer identity on the review
                  </p>
                </div>
                <Switch
                  id="anonymous"
                  checked={isAnonymous}
                  onCheckedChange={setIsAnonymous}
                />
              </div>

              {!isAnonymous && (
                <div className="space-y-2">
                  <Label htmlFor="reviewerName">Reviewer name</Label>
                  <Input
                    id="reviewerName"
                    placeholder="Enter reviewer name..."
                    value={reviewerName}
                    onChange={(e) => setReviewerName(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    This name will be displayed on the review
                  </p>
                </div>
              )}
            </div>

            <Button
              onClick={handleAddReview}
              disabled={isSubmitting || rating === 0}
              className="w-full"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                "Add Review"
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Reviews List */}
      <ScrollArea className="h-[300px]">
        {reviews.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No reviews yet for {trainerName}
          </div>
        ) : (
          <div className="space-y-3 pr-4">
            {reviews.map((review) => (
              <Card key={review.id}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StarRating rating={review.rating} size="sm" />
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(review.created_at), "MMM d, yyyy")}
                        </span>
                      </div>
                      
                      <p className="text-sm font-medium mb-1">
                        {review.is_anonymous
                          ? "Anonymous"
                          : (review as any).reviewer_name || review.profiles?.full_name || "Player"}
                      </p>

                      {review.tags && review.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {review.tags.map(tag => (
                            <Badge key={tag.id} variant="secondary" className="text-xs">
                              {tag.name}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {review.comment && (
                        <p className="text-sm text-muted-foreground">
                          {review.comment}
                        </p>
                      )}
                    </div>

                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteReview(review.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
