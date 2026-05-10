/**
 * Builds a URL to the dynamic OG image edge function.
 * Use as a fallback when an entity has no native image (avatar/banner/cover).
 */

const PROJECT_ID = import.meta.env.VITE_SUPABASE_PROJECT_ID;
const BASE = PROJECT_ID
  ? `https://${PROJECT_ID}.supabase.co/functions/v1/og-image`
  : 'https://padeltrainer.ai/functions/v1/og-image';

export type OgEntityType = 'trainer' | 'academy' | 'club' | 'article' | 'city' | 'generic';

export interface DynamicOgOptions {
  type?: OgEntityType;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  accent?: string; // hex without #
}

export function buildDynamicOgUrl({ type = 'generic', title, subtitle, eyebrow, accent }: DynamicOgOptions): string {
  const params = new URLSearchParams();
  params.set('type', type);
  params.set('title', title.slice(0, 120));
  if (subtitle) params.set('subtitle', subtitle.slice(0, 160));
  if (eyebrow) params.set('eyebrow', eyebrow.slice(0, 40));
  if (accent) params.set('accent', accent.replace(/^#/, ''));
  return `${BASE}?${params.toString()}`;
}
