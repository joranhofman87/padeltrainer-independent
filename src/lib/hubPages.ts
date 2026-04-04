import { sanityClient } from '@/lib/sanity';

export const HUB_PAGE_SLUGS = [
  'padel-strategy-complete-guide',
  'padel-drills-complete-practice-guide',
  'padel-fitness-health-guide',
  'padel-levels-progression-guide',
  'padel-coaching-career-guide',
] as const;

export const HUB_SPOKE_MAPPING: Record<string, string[]> = {
  'padel-strategy-complete-guide': [
    'padel-doubles-strategy-tactics',
    'padel-court-positioning-complete-guide',
    'how-to-dominate-the-net-in-padel-win-more-points',
    'padel-defense-stay-in-the-point-from-the-back',
    'how-to-beat-better-padel-players',
    'padel-return-of-serve-where-to-stand-and-what-to-hit',
  ],
  'padel-drills-complete-practice-guide': [
    '10-padel-drills-you-can-practice-on-your-own',
    'padel-warm-up-routine',
    'padel-drills-for-beginners-8-exercises-to-build-your-foundation',
    'padel-footwork-drills-7-exercises-to-move-faster-on-court',
  ],
  'padel-fitness-health-guide': [
    'health-benefits-of-padel',
    'fitness-training-for-padel',
    'best-stretches-for-padel-players',
    'common-padel-injuries-and-how-to-prevent-them',
    'padel-elbow-causes-treatment-prevention',
    'how-to-avoid-shoulder-injuries-in-padel',
    'recovery-tips-after-padel-match',
    'padel-warm-up-routine',
  ],
  'padel-levels-progression-guide': [
    'padel-levels-explained',
    'beginner-to-intermediate-padel-progression-guide',
    'how-to-play-padel-beginners-guide',
    'padel-starter-kit-everything-you-need',
    'how-to-beat-better-padel-players',
  ],
  'padel-coaching-career-guide': [
    'how-to-start-a-padel-coaching-business-2026',
    'padel-coaching-tips-better-lessons',
    'padel-coach-salary-how-much-earn',
    'how-to-get-more-padel-students-marketing-guide-for-coaches',
    'best-tools-for-padel-coaches-software-apps-equipment-2026',
    'how-to-become-a-padel-coach-complete-career-guide',
  ],
};

export const HUB_METADATA: Record<string, { category: string }> = {
  'padel-strategy-complete-guide': { category: 'Strategy' },
  'padel-drills-complete-practice-guide': { category: 'Drills' },
  'padel-fitness-health-guide': { category: 'Fitness' },
  'padel-levels-progression-guide': { category: 'Levels' },
  'padel-coaching-career-guide': { category: 'Coaching' },
};

export function isHubPage(slug: string): boolean {
  return (HUB_PAGE_SLUGS as readonly string[]).includes(slug);
}

export interface SpokeArticle {
  title: string;
  slug: string;
  excerpt?: string;
  category?: string;
}

export async function getSpokeArticles(hubSlug: string, lang: string): Promise<SpokeArticle[]> {
  const slugs = HUB_SPOKE_MAPPING[hubSlug];
  if (!slugs || slugs.length === 0) return [];

  const results = await sanityClient.fetch<SpokeArticle[]>(
    `*[_type == "blogPost" && slug.current in $slugs && language == $lang && !(_id in path("drafts.**"))]{
      title,
      "slug": slug.current,
      excerpt,
      category
    }`,
    { slugs, lang }
  );

  // Sort to match config order
  const orderMap = new Map(slugs.map((s, i) => [s, i]));
  return results.sort((a, b) => (orderMap.get(a.slug) ?? 99) - (orderMap.get(b.slug) ?? 99));
}
