import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface PlatformStats {
  trainers: number;
  lessons: number;
  avgRating: number;
  cities: number;
  loading: boolean;
}

export function usePlatformStats(): PlatformStats {
  const [stats, setStats] = useState<PlatformStats>({
    trainers: 0,
    lessons: 0,
    avgRating: 4.9,
    cities: 0,
    loading: true
  });

  useEffect(() => {
    async function fetchStats() {
      try {
        // Fetch trainer count
        const { count: trainers } = await supabase
          .from('trainer_profiles')
          .select('*', { count: 'exact', head: true });

        // Fetch completed bookings count (lessons delivered)
        const { count: lessons } = await supabase
          .from('bookings')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'confirmed');

        // Fetch reviews to calculate average rating
        const { data: ratingData } = await supabase
          .from('reviews')
          .select('rating');

        // Fetch unique cities from active locations
        const { data: citiesData } = await supabase
          .from('locations')
          .select('city')
          .eq('is_active', true);

        // Calculate average rating
        const avgRating = ratingData?.length
          ? parseFloat((ratingData.reduce((sum, r) => sum + r.rating, 0) / ratingData.length).toFixed(1))
          : 4.9;

        // Count unique cities
        const uniqueCities = new Set(citiesData?.map(l => l.city)).size;

        setStats({
          trainers: trainers || 0,
          lessons: lessons || 0,
          avgRating,
          cities: uniqueCities,
          loading: false
        });
      } catch (error) {
        console.error('Error fetching platform stats:', error);
        setStats(prev => ({ ...prev, loading: false }));
      }
    }

    fetchStats();
  }, []);

  return stats;
}
