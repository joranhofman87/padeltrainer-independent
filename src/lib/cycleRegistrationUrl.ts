import { getMarketingUrl, getShortUrl } from '@/lib/domains';

export type CycleOwnerType = 'trainer' | 'club' | 'academy';

/** The marketing-route path for a cycle's public registration form. */
export function buildRegistrationPath(
  cycleId: string,
  ownerType: CycleOwnerType,
  ownerSlug?: string | null,
): string {
  if (ownerSlug) {
    if (ownerType === 'club') return `clubs/${ownerSlug}/register/${cycleId}`;
    if (ownerType === 'academy') return `academies/${ownerSlug}/register/${cycleId}`;
  }
  return `register/${cycleId}`;
}

/**
 * The full, shareable URL of a cycle's public registration form — the same URL
 * the "Share link" action copies and the QR code encodes (one source of truth).
 */
export function buildRegistrationUrl(
  cycleId: string,
  ownerType: CycleOwnerType,
  ownerSlug?: string | null,
  lang = 'nl',
): string {
  return getMarketingUrl(buildRegistrationPath(cycleId, ownerType, ownerSlug), lang);
}

/**
 * The canonical share URL for a registration form — ONE place decides it so every share surface
 * (copy button, QR, trainer/academy/club) stays in lockstep: the branded short link
 * (padeltrainer.ai/s/<code>) when a code has been minted (registrations mint eagerly via a DB
 * trigger), else the full registration URL as a fallback. Keep this the single source; do not
 * re-derive the `short_code ? short : long` branch inline at call sites.
 */
export function shareUrlForRegistration(
  shortCode: string | null | undefined,
  cycleId: string,
  ownerType: CycleOwnerType,
  ownerSlug?: string | null,
  lang = 'nl',
): string {
  return shortCode
    ? getShortUrl(shortCode)
    : buildRegistrationUrl(cycleId, ownerType, ownerSlug, lang);
}
