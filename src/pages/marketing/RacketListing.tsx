import { useMemo, useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Filter, X } from 'lucide-react';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { sanityClient, RACKETS_LIST_QUERY } from '@/lib/sanity';
import { RacketCard } from '@/components/gear/RacketCard';
import { RacketFilters, EMPTY_FILTERS, type RacketFilterState } from '@/components/gear/RacketFilters';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

interface RacketListItem {
  _id: string;
  name: string;
  slug: string;
  brand: string;
  level: string;
  priceRange: string;
  priceMidpoint: number;
  shape: string;
  playingStyle: string;
  weight: string;
  armFriendly: boolean;
  shortDescription: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image?: any;
}

export default function RacketListing() {
  const { lang = 'en' } = useParams<{ lang: string }>();
  const { t } = useTranslation('marketing');
  const [searchParams, setSearchParams] = useSearchParams();
  const [showMobileFilters, setShowMobileFilters] = useState(false);

  const { data: rackets = [], isLoading } = useQuery({
    queryKey: ['rackets-list', lang],
    queryFn: () => sanityClient.fetch<RacketListItem[]>(RACKETS_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  // Init filters from URL
  const [filters, setFilters] = useState<RacketFilterState>(() => ({
    brand: searchParams.get('brand')?.split(',').filter(Boolean) || [],
    level: searchParams.get('level') || null,
    playingStyle: searchParams.get('style') || null,
    shape: searchParams.get('shape') || null,
    weight: searchParams.get('weight') || null,
    maxPrice: searchParams.get('maxPrice') ? Number(searchParams.get('maxPrice')) : null,
    armFriendly: searchParams.get('arm') === 'true',
  }));

  // Sync filters → URL
  const syncUrl = useCallback((f: RacketFilterState) => {
    const params = new URLSearchParams();
    if (f.brand.length) params.set('brand', f.brand.join(','));
    if (f.level) params.set('level', f.level);
    if (f.playingStyle) params.set('style', f.playingStyle);
    if (f.shape) params.set('shape', f.shape);
    if (f.weight) params.set('weight', f.weight);
    if (f.maxPrice) params.set('maxPrice', String(f.maxPrice));
    if (f.armFriendly) params.set('arm', 'true');
    setSearchParams(params, { replace: true });
  }, [setSearchParams]);

  const handleFilterChange = (f: RacketFilterState) => {
    setFilters(f);
    syncUrl(f);
  };

  const brands = useMemo(() => {
    const set = new Set(rackets.map(r => r.brand));
    return Array.from(set).sort();
  }, [rackets]);

  const filtered = useMemo(() => rackets.filter(r => {
    if (filters.brand.length && !filters.brand.includes(r.brand)) return false;
    if (filters.level && r.level !== filters.level) return false;
    if (filters.playingStyle && r.playingStyle !== filters.playingStyle) return false;
    if (filters.shape && r.shape !== filters.shape) return false;
    if (filters.weight && r.weight !== filters.weight) return false;
    if (filters.maxPrice && r.priceMidpoint > filters.maxPrice) return false;
    if (filters.armFriendly && !r.armFriendly) return false;
    return true;
  }), [rackets, filters]);

  const seoTitle = t('gear.listing.title', 'Best Padel Rackets 2026 — Compare & Choose');
  const seoDesc = t('gear.listing.description', 'Browse and compare all padel rackets. Filter by level, playing style, shape, weight, and price to find your perfect match.');

  return (
    <MarketingLayout>
      <SEO title={seoTitle} description={seoDesc} url={`/${lang}/gear/rackets`} />

      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mb-10"
        >
          <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {t('gear.listing.h1', 'Padel Rackets')}
          </h1>
          <p className="mt-2 max-w-2xl text-lg text-muted-foreground">
            {t('gear.listing.subtitle', 'Find and compare the best padel rackets for every level and playing style.')}
          </p>
        </motion.div>

        {/* Mobile filter toggle */}
        <div className="mb-6 lg:hidden">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMobileFilters(!showMobileFilters)}
          >
            <Filter className="mr-2 h-4 w-4" />
            {t('gear.filter.title', 'Filters')}
          </Button>
        </div>

        <div className="flex gap-8">
          {/* Sidebar filters */}
          <aside className={`w-64 shrink-0 ${showMobileFilters ? 'block' : 'hidden'} lg:block`}>
            <div className="sticky top-24 rounded-xl border border-border bg-card p-5">
              <RacketFilters
                filters={filters}
                onChange={handleFilterChange}
                brands={brands}
                totalCount={rackets.length}
                filteredCount={filtered.length}
              />
            </div>
          </aside>

          {/* Grid */}
          <div className="flex-1">
            {isLoading ? (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 9 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[3/4] rounded-xl" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-lg text-muted-foreground">
                  {t('gear.listing.noResults', 'No rackets match your filters.')}
                </p>
                <Button variant="outline" className="mt-4" onClick={() => handleFilterChange(EMPTY_FILTERS)}>
                  {t('gear.clearAll', 'Clear all')}
                </Button>
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4 }}
                className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3"
              >
                {filtered.map((r, i) => (
                  <motion.div
                    key={r._id}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: Math.min(i * 0.05, 0.4), ease: [0.16, 1, 0.3, 1] }}
                  >
                    <RacketCard
                      name={r.name}
                      slug={r.slug}
                      brand={r.brand}
                      level={r.level}
                      playingStyle={r.playingStyle}
                      shape={r.shape}
                      priceRange={r.priceRange}
                      shortDescription={r.shortDescription}
                      armFriendly={r.armFriendly}
                      image={r.image}
                    />
                  </motion.div>
                ))}
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
