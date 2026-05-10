/**
 * Reusable JSON-LD structured-data builders.
 *
 * Keep schemas tiny and focused — each page composes the builders it needs.
 * All helpers return plain objects ready to pass to <SEO structuredData={[...]}/>.
 */
import { MARKETING_DOMAIN } from '@/lib/domains';

export interface BreadcrumbStep {
  name: string;
  /** Full URL or relative path (relative paths are resolved against MARKETING_DOMAIN). */
  url?: string;
}

/** Build a Schema.org BreadcrumbList. The last step typically omits `url`. */
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

export interface FaqEntry { question: string; answer: string; }

/** Build a Schema.org FAQPage. */
export function buildFaqPage(items: FaqEntry[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: answer,
      },
    })),
  };
}
