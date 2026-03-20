import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getBannersByZone, pickWeightedBanner } from '@/lib/banners';
import { BannerAd } from './BannerAd';

interface BannerZoneProps {
  zone: 'header' | 'sidebar' | 'in-article' | 'footer' | 'blog-listing' | 'homepage-hero';
  category?: string;
  className?: string;
}

export function BannerZone({ zone, category, className }: BannerZoneProps) {
  const { i18n } = useTranslation();

  const { data: banners } = useQuery({
    queryKey: ['banners', zone, i18n.language, category],
    queryFn: () => getBannersByZone(zone, { language: i18n.language, category }),
    staleTime: 1000 * 60 * 10,
  });

  const banner = useMemo(() => pickWeightedBanner(banners ?? []), [banners]);

  if (!banner) return null;

  return (
    <div className={className}>
      <BannerAd banner={banner} />
    </div>
  );
}
