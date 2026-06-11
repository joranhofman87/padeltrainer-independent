import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Card, CardContent } from '@/components/ui/card';
import { Star, ArrowRight } from 'lucide-react';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useTranslation } from 'react-i18next';

interface TopRatedLocation {
  id: string;
  name: string;
  slug: string;
  avg_overall: number;
  review_count: number;
}

interface TopRatedCourtsProps {
  cityLocations: { id: string; name: string; slug: string }[];
}

export function TopRatedCourts({ cityLocations }: TopRatedCourtsProps) {
  const { t } = useTranslation('marketing');
  const [topRated, setTopRated] = useState<TopRatedLocation[]>([]);

  useEffect(() => {
    if (cityLocations.length === 0) return;

    async function fetchStats() {
      const locationIds = cityLocations.map(l => l.id);

      // Get approved reviews grouped by location
      const { data, error } = await supabase
        .from('court_reviews')
        .select('location_id, overall_rating')
        .in('location_id', locationIds)
        .eq('status', 'approved');

      if (error || !data || data.length === 0) return;

      // Aggregate per location
      const statsMap: Record<string, { total: number; count: number }> = {};
      data.forEach(r => {
        if (!statsMap[r.location_id]) statsMap[r.location_id] = { total: 0, count: 0 };
        statsMap[r.location_id].total += Number(r.overall_rating);
        statsMap[r.location_id].count += 1;
      });

      // Map to locations with at least 1 review, sort by avg
      const results: TopRatedLocation[] = Object.entries(statsMap)
        .filter(([, s]) => s.count >= 1)
        .map(([locId, s]) => {
          const loc = cityLocations.find(l => l.id === locId);
          return {
            id: locId,
            name: loc?.name || '',
            slug: loc?.slug || '',
            avg_overall: Math.round((s.total / s.count) * 10) / 10,
            review_count: s.count,
          };
        })
        .sort((a, b) => b.avg_overall - a.avg_overall)
        .slice(0, 5);

      setTopRated(results);
    }

    fetchStats();
  }, [cityLocations]);

  if (topRated.length === 0) return null;

  return (
    <section className="py-16 bg-muted/30">
      <div className="container mx-auto px-4">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-8">
          ⭐ {t('cityLanding.topRatedCourts', 'Top Rated Padel Courts')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {topRated.map((loc, i) => (
            <LocalizedLink key={loc.id} to={`/clubs/${loc.slug}`} className="block">
              <Card className="hover:shadow-lg transition-shadow hover:border-primary/50 h-full">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs text-muted-foreground font-medium">#{i + 1}</span>
                      <h3 className="font-semibold text-foreground">{loc.name}</h3>
                    </div>
                    <div className="flex items-center gap-1">
                      <Star className="h-4 w-4 fill-primary text-primary" />
                      <span className="font-bold text-foreground">{loc.avg_overall}</span>
                      <span className="text-xs text-muted-foreground">({loc.review_count})</span>
                    </div>
                  </div>
                  <p className="text-sm text-primary font-medium mt-3 flex items-center gap-1">
                    {t('cityLanding.viewProfile', 'View Profile')} <ArrowRight className="h-3 w-3" />
                  </p>
                </CardContent>
              </Card>
            </LocalizedLink>
          ))}
        </div>
      </div>
    </section>
  );
}
