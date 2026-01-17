import { supabase } from '@/integrations/supabase/client';

export interface Review {
  id: string;
  booking_id: string;
  player_id: string;
  trainer_id: string;
  rating: number;
  comment: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReviewWithDetails extends Review {
  profiles?: {
    full_name: string | null;
    avatar_url: string | null;
  };
}

export async function createReview(
  bookingId: string,
  playerId: string,
  trainerId: string,
  rating: number,
  comment?: string,
  isPublic: boolean = true
) {
  return supabase
    .from('reviews')
    .insert({
      booking_id: bookingId,
      player_id: playerId,
      trainer_id: trainerId,
      rating,
      comment,
      is_public: isPublic,
    })
    .select()
    .single();
}

export async function getTrainerReviews(trainerId: string) {
  // First get reviews
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('trainer_id', trainerId)
    .eq('is_public', true)
    .order('created_at', { ascending: false });

  if (error || !reviews) return { data: null, error };

  // Then get player profiles for those reviews (using public view to protect PII)
  const playerIds = [...new Set(reviews.map(r => r.player_id))];
  const { data: profiles } = await supabase
    .from('profiles_public')
    .select('id, full_name, avatar_url')
    .in('id', playerIds);

  const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

  const reviewsWithProfiles = reviews.map(review => ({
    ...review,
    profiles: profileMap.get(review.player_id) || null,
  }));

  return { data: reviewsWithProfiles, error: null };
}

export async function getTrainerAverageRating(trainerId: string) {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('trainer_id', trainerId)
    .eq('is_public', true);

  if (error || !data || data.length === 0) {
    return { average: null, count: 0, error };
  }

  const average = data.reduce((sum, r) => sum + r.rating, 0) / data.length;
  return { average: Math.round(average * 10) / 10, count: data.length, error: null };
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
