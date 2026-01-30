import { supabase } from '@/integrations/supabase/client';

export interface Review {
  id: string;
  booking_id: string;
  player_id: string;
  trainer_id: string;
  rating: number;
  comment: string | null;
  is_public: boolean;
  is_anonymous: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReviewWithDetails extends Review {
  profiles?: {
    full_name: string | null;
    avatar_url: string | null;
  };
  tags?: ReviewTag[];
  trainer_name?: string;
}

export interface ReviewTag {
  id: string;
  name: string;
  name_nl: string;
  category: string;
  is_active: boolean;
  display_order: number;
}

export async function getReviewTags() {
  const { data, error } = await supabase
    .from('review_tags')
    .select('*')
    .eq('is_active', true)
    .order('display_order');

  return { data: data as ReviewTag[] | null, error };
}

export async function createReview(
  bookingId: string,
  playerId: string,
  trainerId: string,
  rating: number,
  comment?: string,
  isAnonymous: boolean = false
) {
  return supabase
    .from('reviews')
    .insert({
      booking_id: bookingId,
      player_id: playerId,
      trainer_id: trainerId,
      rating,
      comment,
      is_public: true,
      is_anonymous: isAnonymous,
    })
    .select()
    .single();
}

export async function createReviewWithTags(
  bookingId: string,
  playerId: string,
  trainerId: string,
  rating: number,
  tagIds: string[],
  comment?: string,
  isAnonymous: boolean = false
) {
  // Create the review first
  const { data: review, error: reviewError } = await createReview(
    bookingId,
    playerId,
    trainerId,
    rating,
    comment,
    isAnonymous
  );

  if (reviewError || !review) {
    return { data: null, error: reviewError };
  }

  // Insert tag selections if any
  if (tagIds.length > 0) {
    const tagSelections = tagIds.map(tagId => ({
      review_id: review.id,
      tag_id: tagId,
    }));

    const { error: tagsError } = await supabase
      .from('review_tag_selections')
      .insert(tagSelections);

    if (tagsError) {
      console.error('Error inserting review tags:', tagsError);
    }
  }

  return { data: review, error: null };
}

export async function getTrainerReviews(trainerId: string) {
  // Get all reviews
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('trainer_id', trainerId)
    .order('created_at', { ascending: false });

  if (error || !reviews) return { data: null, error };

  // Get player profiles
  const playerIds = [...new Set(reviews.map(r => r.player_id))];
  const { data: profiles } = await supabase
    .from('profiles_public')
    .select('id, full_name, avatar_url')
    .in('id', playerIds);

  // Get tag selections for these reviews
  const reviewIds = reviews.map(r => r.id);
  const { data: tagSelections } = await supabase
    .from('review_tag_selections')
    .select('review_id, tag_id')
    .in('review_id', reviewIds);

  // Get tag details
  const tagIds = [...new Set(tagSelections?.map(ts => ts.tag_id) || [])];
  const { data: tags } = tagIds.length > 0
    ? await supabase.from('review_tags').select('*').in('id', tagIds)
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

  const reviewsWithProfiles = reviews.map(review => ({
    ...review,
    profiles: profileMap.get(review.player_id) || null,
    tags: reviewTagsMap.get(review.id) || [],
  }));

  return { data: reviewsWithProfiles, error: null };
}

export async function getTrainerAverageRating(trainerId: string) {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('trainer_id', trainerId);

  if (error || !data || data.length === 0) {
    return { average: null, count: 0, error };
  }

  const average = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
  return { average: Math.round(average * 10) / 10, count: data.length, error: null };
}

export async function getBatchTrainerRatings(trainerIds: string[]) {
  if (trainerIds.length === 0) return new Map<string, { average: number; count: number }>();

  const { data, error } = await supabase
    .from('reviews')
    .select('trainer_id, rating')
    .in('trainer_id', trainerIds);

  if (error || !data) return new Map<string, { average: number; count: number }>();

  const ratingsMap = new Map<string, { sum: number; count: number }>();

  data.forEach(review => {
    const existing = ratingsMap.get(review.trainer_id) || { sum: 0, count: 0 };
    ratingsMap.set(review.trainer_id, {
      sum: existing.sum + review.rating,
      count: existing.count + 1,
    });
  });

  const result = new Map<string, { average: number; count: number }>();
  ratingsMap.forEach((value, trainerId) => {
    result.set(trainerId, {
      average: Math.round((value.sum / value.count) * 10) / 10,
      count: value.count,
    });
  });

  return result;
}

export async function getPlayerReview(bookingId: string) {
  return supabase
    .from('reviews')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle();
}

export async function updateReview(reviewId: string, rating: number, comment?: string) {
  return supabase
    .from('reviews')
    .update({ rating, comment })
    .eq('id', reviewId)
    .select()
    .single();
}

export async function getTrainerTagCounts(trainerId: string) {
  // Get all reviews for this trainer
  const { data: reviews } = await supabase
    .from('reviews')
    .select('id')
    .eq('trainer_id', trainerId);

  if (!reviews || reviews.length === 0) return new Map<string, number>();

  const reviewIds = reviews.map(r => r.id);

  // Get tag selections
  const { data: tagSelections } = await supabase
    .from('review_tag_selections')
    .select('tag_id')
    .in('review_id', reviewIds);

  // Count occurrences
  const counts = new Map<string, number>();
  tagSelections?.forEach(ts => {
    counts.set(ts.tag_id, (counts.get(ts.tag_id) || 0) + 1);
  });

  return counts;
}

export async function getAcademyAggregatedReviews(academyId: string) {
  // Get all trainer IDs for the academy
  const { data: academyTrainers } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', academyId)
    .eq('status', 'active');

  if (!academyTrainers || academyTrainers.length === 0) {
    return { data: [], average: null, count: 0, error: null };
  }

  const trainerIds = academyTrainers.map(t => t.trainer_profile_id);

  // Get all reviews for these trainers
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('*')
    .in('trainer_id', trainerIds)
    .order('created_at', { ascending: false });

  if (error || !reviews) return { data: null, average: null, count: 0, error };

  // Get player profiles
  const playerIds = [...new Set(reviews.map(r => r.player_id))];
  const { data: profiles } = await supabase
    .from('profiles_public')
    .select('id, full_name, avatar_url')
    .in('id', playerIds);

  // Get trainer names
  const { data: trainerProfiles } = await supabase
    .from('trainer_profiles')
    .select('id, user_id')
    .in('id', trainerIds);

  const trainerUserIds = trainerProfiles?.map(tp => tp.user_id) || [];
  const { data: trainerNames } = trainerUserIds.length > 0
    ? await supabase.from('profiles_public').select('id, full_name').in('id', trainerUserIds)
    : { data: [] };

  // Build lookup maps
  const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);
  const trainerUserMap = new Map<string, string>(
    (trainerProfiles || []).map(tp => [tp.id, tp.user_id] as [string, string])
  );
  const userNameMap = new Map<string, string | null>(
    (trainerNames || []).map(p => [p.id, p.full_name] as [string, string | null])
  );

  // Get tags for reviews
  const reviewIds = reviews.map(r => r.id);
  const { data: tagSelections } = await supabase
    .from('review_tag_selections')
    .select('review_id, tag_id')
    .in('review_id', reviewIds);

  const tagIds = [...new Set(tagSelections?.map(ts => ts.tag_id) || [])];
  const { data: tags } = tagIds.length > 0
    ? await supabase.from('review_tags').select('*').in('id', tagIds)
    : { data: [] };

  const tagMap = new Map((tags as ReviewTag[])?.map(t => [t.id, t]) || []);
  const reviewTagsMap = new Map<string, ReviewTag[]>();
  tagSelections?.forEach(ts => {
    const tag = tagMap.get(ts.tag_id);
    if (tag) {
      const existing = reviewTagsMap.get(ts.review_id) || [];
      existing.push(tag);
      reviewTagsMap.set(ts.review_id, existing);
    }
  });

  const reviewsWithDetails: ReviewWithDetails[] = reviews.map(review => {
    const trainerUserId = trainerUserMap.get(review.trainer_id);
    const trainerName = trainerUserId ? userNameMap.get(trainerUserId) : undefined;
    return {
      ...review,
      profiles: profileMap.get(review.player_id) || undefined,
      tags: reviewTagsMap.get(review.id) || [],
      trainer_name: trainerName || undefined,
    };
  });

  // Calculate average
  const average = reviews.length > 0
    ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
    : null;

  return { data: reviewsWithDetails, average, count: reviews.length, error: null };
}
