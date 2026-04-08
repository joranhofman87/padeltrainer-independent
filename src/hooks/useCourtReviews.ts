import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';

export interface CourtReview {
  id: string;
  location_id: string;
  user_id: string;
  rating_surface: number;
  rating_glass: number;
  rating_lighting: number;
  rating_space: number;
  rating_changing_rooms: number;
  rating_booking: number;
  rating_value: number;
  rating_atmosphere: number;
  rating_parking: number;
  rating_beginner_friendly: number;
  overall_rating: number;
  best_thing: string | null;
  improvement: string | null;
  player_level: string | null;
  play_frequency: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CourtReviewInsert {
  location_id: string;
  rating_surface: number;
  rating_glass: number;
  rating_lighting: number;
  rating_space: number;
  rating_changing_rooms: number;
  rating_booking: number;
  rating_value: number;
  rating_atmosphere: number;
  rating_parking: number;
  rating_beginner_friendly: number;
  best_thing?: string;
  improvement?: string;
  player_level?: string;
  play_frequency?: string;
}

export interface ReviewStats {
  total_count: number;
  avg_overall: number;
  avg_surface: number;
  avg_glass: number;
  avg_lighting: number;
  avg_space: number;
  avg_changing_rooms: number;
  avg_booking: number;
  avg_value: number;
  avg_atmosphere: number;
  avg_parking: number;
  avg_beginner_friendly: number;
}

// Fetch approved reviews for a location
export function useLocationReviews(locationId: string | undefined) {
  return useQuery({
    queryKey: ['court-reviews', locationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('court_reviews')
        .select('*')
        .eq('location_id', locationId!)
        .eq('status', 'approved')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as CourtReview[];
    },
    enabled: !!locationId,
  });
}

// Fetch review stats for a location
export function useLocationReviewStats(locationId: string | undefined) {
  return useQuery({
    queryKey: ['court-review-stats', locationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_location_review_stats', {
        _location_id: locationId!,
      });
      if (error) throw error;
      return data as unknown as ReviewStats | null;
    },
    enabled: !!locationId,
  });
}

// Check if user already reviewed a location
export function useUserReviewForLocation(locationId: string | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['court-review-mine', locationId, user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('court_reviews')
        .select('*')
        .eq('location_id', locationId!)
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as CourtReview | null;
    },
    enabled: !!locationId && !!user,
  });
}

// Submit a review
export function useSubmitReview() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (review: CourtReviewInsert) => {
      if (!user) throw new Error('Must be logged in');
      const { data, error } = await supabase
        .from('court_reviews')
        .insert([{ ...review, user_id: user.id }] as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['court-reviews', data.location_id] });
      queryClient.invalidateQueries({ queryKey: ['court-review-stats', data.location_id] });
      queryClient.invalidateQueries({ queryKey: ['court-review-mine', data.location_id] });
    },
  });
}

// Admin: fetch all reviews with location info
export function useAdminReviews(statusFilter: string = 'all') {
  return useQuery({
    queryKey: ['admin-court-reviews', statusFilter],
    queryFn: async () => {
      let query = supabase
        .from('court_reviews')
        .select(`
          *,
          locations!inner(name, city, country, slug)
        `)
        .order('created_at', { ascending: false })
        .limit(200);

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter as any);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });
}

// Admin: update review status
export function useUpdateReviewStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from('court_reviews')
        .update({ status } as any)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-court-reviews'] });
    },
  });
}
