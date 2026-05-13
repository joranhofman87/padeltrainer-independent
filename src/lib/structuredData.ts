/**
 * Reusable JSON-LD structured-data builders.
 *
 * Each helper returns a plain object (or `null` when not enough data) that
 * pages compose into the array passed to `<SEO structuredData={[...]} />`.
 * Builders never throw — they return null so callers can `.filter(Boolean)`.
 */
import { MARKETING_DOMAIN } from '@/lib/domains';

const ORG_NAME = 'PadelTrainer.ai';
const ORG_LOGO = `${MARKETING_DOMAIN}/favicon.png`;

// ─── Breadcrumbs ───────────────────────────────────────────────

export interface BreadcrumbStep {
  name: string;
  /** Full URL or relative path. Relative paths are resolved against MARKETING_DOMAIN. Omit on the leaf. */
  url?: string;
}

export function buildBreadcrumbList(steps: BreadcrumbStep[]) {
  const itemListElement = steps.map((step, i) => {
    const item: Record<string, unknown> = {
      '@type': 'ListItem',
      position: i + 1,
      name: step.name,
    };
    if (step.url) {
      item.item = step.url.startsWith('http')
        ? step.url
        : `${MARKETING_DOMAIN}${step.url.startsWith('/') ? '' : '/'}${step.url}`;
    }
    return item;
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement,
  };
}

// ─── FAQs ──────────────────────────────────────────────────────

export interface FaqEntry { question: string; answer: string; }

/** Returns null when fewer than 2 FAQs to avoid spammy single-question pages. */
export function buildFaqPage(items: FaqEntry[]) {
  if (!items || items.length < 2) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

// ─── Article ───────────────────────────────────────────────────

export interface ArticleInput {
  headline: string;
  description?: string;
  image?: string;
  datePublished?: string;
  dateModified?: string;
  authorName?: string;
  lang: string;
  url: string; // full URL
}

export function buildArticle(a: ArticleInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.headline,
    ...(a.description && { description: a.description }),
    ...(a.image && { image: a.image }),
    ...(a.datePublished && { datePublished: a.datePublished }),
    ...(a.dateModified && { dateModified: a.dateModified }),
    author: {
      '@type': 'Person',
      name: a.authorName || `${ORG_NAME} Editorial Team`,
    },
    publisher: {
      '@type': 'Organization',
      name: ORG_NAME,
      logo: { '@type': 'ImageObject', url: ORG_LOGO },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': a.url },
    inLanguage: a.lang,
  };
}

// ─── HowTo ─────────────────────────────────────────────────────

export interface HowToStep { name?: string; text: string; image?: string; url?: string; }

export interface HowToInput {
  name: string;
  description?: string;
  image?: string;
  totalTime?: string;
  lang: string;
  steps: HowToStep[];
}

/** Returns null when fewer than 3 steps — Google penalises thin HowTo schema. */
export function buildHowTo(h: HowToInput) {
  if (!h.steps || h.steps.length < 3) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: h.name,
    ...(h.description && { description: h.description }),
    ...(h.image && { image: h.image }),
    totalTime: h.totalTime || 'PT15M',
    inLanguage: h.lang,
    step: h.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name || `Step ${i + 1}`,
      text: s.text,
      ...(s.image && { image: s.image }),
      ...(s.url && { url: s.url }),
    })),
  };
}

// ─── Person ────────────────────────────────────────────────────

export interface PersonInput {
  name: string;
  bio?: string | null;
  image?: string | null;
  jobTitle?: string;
  knowsAbout?: string[];
  url: string;
  addressLocality?: string;
  sameAs?: string[];
  /** Optional extras (aggregateRating, review, makesOffer, …) merged at the top level. */
  extras?: Record<string, unknown>;
}

/** Returns null when bio is empty — don't emit a stub Person profile. */
export function buildPerson(p: PersonInput) {
  if (!p.bio || !p.bio.trim()) return null;
  const knowsAbout = Array.from(new Set(['Padel', ...(p.knowsAbout || [])])).filter(Boolean);
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: p.name,
    jobTitle: p.jobTitle || 'Padel Coach',
    description: p.bio,
    ...(p.image && { image: p.image }),
    knowsAbout,
    url: p.url,
    ...(p.addressLocality && {
      address: { '@type': 'PostalAddress', addressLocality: p.addressLocality },
    }),
    ...(p.sameAs && p.sameAs.length > 0 && { sameAs: p.sameAs }),
    ...(p.extras || {}),
  };
}

// ─── CollectionPage ────────────────────────────────────────────

export interface CollectionPageInput {
  name: string;
  description?: string;
  url: string;
  lang: string;
}

export function buildCollectionPage(c: CollectionPageInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: c.name,
    ...(c.description && { description: c.description }),
    url: c.url,
    isPartOf: { '@type': 'WebSite', name: ORG_NAME, url: MARKETING_DOMAIN },
    inLanguage: c.lang,
  };
}

// ─── ItemList ──────────────────────────────────────────────────

export interface ItemListEntry { name: string; url: string; image?: string; }

export function buildItemList(name: string, items: ItemListEntry[]) {
  if (!items || items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      url: it.url.startsWith('http') ? it.url : `${MARKETING_DOMAIN}${it.url}`,
      ...(it.image && { image: it.image }),
    })),
  };
}

// ─── Sports / Local Business ───────────────────────────────────

export interface SportsLocationInput {
  name: string;
  description?: string;
  url: string;
  street?: string;
  city: string;
  postalCode?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  telephone?: string;
  image?: string;
  sameAs?: string[];
}

export function buildSportsActivityLocation(l: SportsLocationInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    name: l.name,
    ...(l.description && { description: l.description }),
    url: l.url,
    sport: 'Padel',
    address: {
      '@type': 'PostalAddress',
      ...(l.street && { streetAddress: l.street }),
      addressLocality: l.city,
      ...(l.postalCode && { postalCode: l.postalCode }),
      addressCountry: l.country || 'NL',
    },
    ...(l.latitude && l.longitude && {
      geo: { '@type': 'GeoCoordinates', latitude: l.latitude, longitude: l.longitude },
    }),
    ...(l.telephone && { telephone: l.telephone }),
    ...(l.image && { image: l.image }),
    ...(l.sameAs && l.sameAs.length > 0 && { sameAs: l.sameAs }),
  };
}

// ─── Organization & WebSite (homepage) ─────────────────────────

export function buildOrganization() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ORG_NAME,
    url: MARKETING_DOMAIN,
    logo: ORG_LOGO,
    sameAs: [
      'https://www.instagram.com/padeltrainer.ai',
      'https://www.linkedin.com/company/padeltrainer-ai',
      'https://www.tiktok.com/@padeltrainer.ai',
    ],
  };
}

export function buildWebSite(opts?: { description?: string; searchUrl?: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: ORG_NAME,
    url: MARKETING_DOMAIN,
    ...(opts?.description && { description: opts.description }),
    ...(opts?.searchUrl && {
      potentialAction: {
        '@type': 'SearchAction',
        target: `${opts.searchUrl}?search={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    }),
  };
}

// ─── VideoObject ───────────────────────────────────────────────

export interface VideoObjectInput {
  name: string;
  description: string;
  thumbnailUrl?: string;
  uploadDate?: string;
  embedUrl?: string;
  contentUrl?: string;
  duration?: string; // ISO 8601, e.g. "PT2M30S"
}

export function buildVideoObject(v: VideoObjectInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: v.name,
    description: v.description,
    ...(v.thumbnailUrl && { thumbnailUrl: v.thumbnailUrl }),
    ...(v.uploadDate && { uploadDate: v.uploadDate }),
    ...(v.embedUrl && { embedUrl: v.embedUrl }),
    ...(v.contentUrl && { contentUrl: v.contentUrl }),
    ...(v.duration && { duration: v.duration }),
  };
}

// ─── Product ───────────────────────────────────────────────────

export interface ProductInput {
  name: string;
  description?: string;
  image?: string | string[];
  brand?: string;
  sku?: string;
  url?: string;
  offers?: { price: number; priceCurrency: string; availability?: string; url?: string };
  aggregateRating?: { ratingValue: number; reviewCount: number };
}

export function buildProduct(p: ProductInput) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    ...(p.description && { description: p.description }),
    ...(p.image && { image: p.image }),
    ...(p.brand && { brand: { '@type': 'Brand', name: p.brand } }),
    ...(p.sku && { sku: p.sku }),
    ...(p.url && { url: p.url }),
    ...(p.offers && {
      offers: {
        '@type': 'Offer',
        price: p.offers.price,
        priceCurrency: p.offers.priceCurrency,
        availability: p.offers.availability || 'https://schema.org/InStock',
        ...(p.offers.url && { url: p.offers.url }),
      },
    }),
    ...(p.aggregateRating && {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: p.aggregateRating.ratingValue,
        reviewCount: p.aggregateRating.reviewCount,
        bestRating: 5,
        worstRating: 1,
      },
    }),
  };
}
