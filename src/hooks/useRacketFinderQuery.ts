import { useQuery } from '@tanstack/react-query';
import { sanityClient } from '@/lib/sanity';

export interface QuizAnswers {
  level: 'beginner' | 'intermediate' | 'advanced';
  style: 'control' | 'allround' | 'power';
  budget: number;
  armFriendly: boolean;
  weight: 'light' | 'medium' | 'heavy' | 'any';
  shape: 'round' | 'teardrop' | 'diamond' | 'any';
}

export interface RacketResult {
  _id: string;
  name: string;
  brand: string;
  level: string;
  priceRange: string;
  priceMidpoint: number;
  shortDescription: string;
  specs: string;
  shape: string;
  playingStyle: string;
  weight: string;
  armFriendly: boolean;
  affiliateUrl: string;
  slug: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image?: any;
  shop?: string;
  isAvailable?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  description?: any[];
}

function getLevels(level: string): string[] {
  switch (level) {
    case 'beginner': return ['beginner', 'all'];
    case 'intermediate': return ['intermediate', 'beginner', 'all'];
    case 'advanced': return ['advanced', 'intermediate', 'all'];
    default: return ['beginner', 'all'];
  }
}

function getStyles(style: string): string[] {
  if (style === 'allround') return ['allround'];
  return [style, 'allround'];
}

const PROJECTION = `{
  _id, name, brand, level, priceRange, priceMidpoint,
  shortDescription, specs, shape, playingStyle, weight,
  armFriendly, affiliateUrl, "slug": slug.current
}`;

async function fetchRackets(answers: QuizAnswers, lang: string): Promise<RacketResult[]> {
  const levels = getLevels(answers.level);
  const styles = getStyles(answers.style);

  // Build filter parts
  const baseParts = [
    '_type == "product"',
    'category == "racket"',
    'language == $lang',
    '!(_id in path("drafts.**"))',
    'level in $levels',
    'playingStyle in $styles',
    'priceMidpoint <= $maxPrice',
  ];
  if (answers.armFriendly) baseParts.push('armFriendly == true');

  const params: Record<string, any> = {
    lang,
    levels,
    styles,
    maxPrice: answers.budget,
  };

  // Try with all filters
  const withWeight = answers.weight !== 'any';
  const withShape = answers.shape !== 'any';

  const filterParts = [...baseParts];
  if (withWeight) {
    filterParts.push('weight == $weight');
    params.weight = answers.weight;
  }
  if (withShape) {
    filterParts.push('shape == $shape');
    params.shape = answers.shape;
  }

  let query = `*[${filterParts.join(' && ')}] | order(priceMidpoint asc) [0...3] ${PROJECTION}`;
  let results = await sanityClient.fetch<RacketResult[]>(query, params);

  // Relax weight filter if < 2 results
  if (results.length < 2 && withWeight) {
    const relaxed = baseParts.slice();
    if (withShape) {
      relaxed.push('shape == $shape');
    }
    const relaxedParams = { ...params };
    delete relaxedParams.weight;
    query = `*[${relaxed.join(' && ')}] | order(priceMidpoint asc) [0...3] ${PROJECTION}`;
    results = await sanityClient.fetch<RacketResult[]>(query, relaxedParams);
  }

  // Relax shape filter too if still < 2 results
  if (results.length < 2 && withShape) {
    const relaxedParams = { ...params };
    delete relaxedParams.weight;
    delete relaxedParams.shape;
    query = `*[${baseParts.join(' && ')}] | order(priceMidpoint asc) [0...3] ${PROJECTION}`;
    results = await sanityClient.fetch<RacketResult[]>(query, relaxedParams);
  }

  return results;
}

export function useRacketFinderQuery(answers: QuizAnswers | null, lang: string) {
  return useQuery({
    queryKey: ['racket-finder', answers, lang],
    queryFn: () => fetchRackets(answers!, lang),
    enabled: !!answers,
    staleTime: 1000 * 60 * 10,
  });
}
