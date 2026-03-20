import { sanityClient } from '@/lib/sanity';

export interface BannerData {
  _id: string;
  title: string;
  trackingId: string;
  clickUrl: string;
  ctaText?: string;
  weight: number;
  zone: string;
  targetLanguages?: string[];
  targetCategories?: string[];
  image: string;
  imageAlt?: string;
  sponsorName: string;
  sponsorSlug: string;
  sponsorPlan: string;
}

const BANNERS_BY_ZONE_QUERY = `*[
  _type == "banner"
  && isActive == true
  && zone == $zone
  && (!defined(startDate) || startDate <= $now)
  && (!defined(endDate) || endDate >= $now)
  && sponsor->isActive == true
] | order(weight desc) {
  _id,
  title,
  "trackingId": coalesce(trackingId, _id),
  clickUrl,
  ctaText,
  weight,
  zone,
  targetLanguages,
  targetCategories,
  "image": image.asset->url,
  "imageAlt": image.alt,
  "sponsorName": sponsor->name,
  "sponsorSlug": sponsor->slug.current,
  "sponsorPlan": sponsor->plan
}`;

export async function getBannersByZone(
  zone: string,
  options?: { language?: string; category?: string }
): Promise<BannerData[]> {
  const now = new Date().toISOString();
  const banners = await sanityClient.fetch<BannerData[]>(BANNERS_BY_ZONE_QUERY, { zone, now });

  return banners.filter((b) => {
    const langMatch =
      !b.targetLanguages?.length ||
      b.targetLanguages.includes('all') ||
      b.targetLanguages.includes(options?.language ?? '');
    const catMatch =
      !b.targetCategories?.length ||
      b.targetCategories.includes('all') ||
      b.targetCategories.includes(options?.category ?? '');
    return langMatch && catMatch;
  });
}

/** Weighted random selection — higher weight = more likely to be picked. */
export function pickWeightedBanner(banners: BannerData[]): BannerData | null {
  if (!banners.length) return null;
  const totalWeight = banners.reduce((sum, b) => sum + (b.weight || 10), 0);
  let random = Math.random() * totalWeight;
  for (const banner of banners) {
    random -= banner.weight || 10;
    if (random <= 0) return banner;
  }
  return banners[0];
}
