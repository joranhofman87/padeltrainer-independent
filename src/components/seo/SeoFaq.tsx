import { useTranslation } from 'react-i18next';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export type FaqItem = { question: string; answer: string };

interface SeoFaqProps {
  /** Pre-built localized FAQ items (recommended). */
  items: FaqItem[];
  /** Override the section heading. Defaults to a localized "Frequently Asked Questions". */
  heading?: string;
  /** Optional className applied to the wrapping section. */
  className?: string;
}

/**
 * Visible FAQ accordion + matching FAQPage JSON-LD for rich-result eligibility.
 * Crawlers (Google, Bing, ChatGPT, Perplexity) parse both the visible H3 + body
 * and the JSON-LD payload — boosting CTR even at the same rank.
 */
export function SeoFaq({ items, heading, className }: SeoFaqProps) {
  const { t } = useTranslation('marketing');
  const safeItems = (items || []).filter(i => i?.question && i?.answer);
  if (safeItems.length === 0) return null;

  const sectionTitle = heading ?? t('seoFaq.heading', 'Frequently Asked Questions');
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: safeItems.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };

  return (
    <section className={className ?? 'container mx-auto max-w-3xl px-4 py-12'}>
      <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-6 text-foreground">
        {sectionTitle}
      </h2>
      <Accordion type="single" collapsible className="w-full">
        {safeItems.map((item, idx) => (
          <AccordionItem key={idx} value={`faq-${idx}`}>
            <AccordionTrigger className="text-left text-base md:text-lg font-medium">
              {item.question}
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground text-sm md:text-base leading-relaxed">
              {item.answer}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <script
        type="application/ld+json"
        // FAQPage schema for rich results
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
    </section>
  );
}

export default SeoFaq;
