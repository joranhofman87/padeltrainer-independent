import { getMarketingUrl } from '@/lib/domains';

export type AcademyShareVisibilityInput = {
  is_public: boolean;
  subscription_status: string | null;
};

export function canShareAcademyPublicly(academy: AcademyShareVisibilityInput): boolean {
  return academy.is_public === true && academy.subscription_status === 'active';
}

export function getAcademyPreviewUrl(slug: string, lang: string = 'nl'): string {
  const normalizedLang = lang === 'en' || lang === 'nl' ? lang : 'nl';
  return `${getMarketingUrl(`academies/${slug}`, normalizedLang)}?preview=true`;
}
