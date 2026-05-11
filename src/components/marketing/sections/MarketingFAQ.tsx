import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { MarketingSection } from './MarketingSection';

interface FAQItem {
  question: string;
  answer: React.ReactNode;
}

interface MarketingFAQProps {
  id?: string;
  eyebrow?: React.ReactNode;
  heading?: React.ReactNode;
  items: FAQItem[];
  /** Inject FAQPage JSON-LD */
  schema?: boolean;
  background?: 'default' | 'cream' | 'off';
}

/**
 * Reusable FAQ accordion in a card-chip - mirrors homepage FAQSection.
 * Pass plain-text answers to opt into FAQPage schema.
 */
export function MarketingFAQ({
  id = 'faq',
  eyebrow,
  heading,
  items,
  schema = true,
  background = 'cream',
}: MarketingFAQProps) {
  const faqSchema = schema
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: items.map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: typeof item.answer === 'string' ? item.answer : '',
          },
        })),
      }
    : null;

  return (
    <MarketingSection
      id={id}
      eyebrow={eyebrow}
      heading={heading}
      background={background}
      containerClassName="max-w-3xl"
    >
      {faqSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
        />
      )}
      <div className="card-chip p-2 md:p-4">
        <Accordion type="single" collapsible className="w-full">
          {items.map((item, i) => (
            <AccordionItem
              key={i}
              value={`faq-${i}`}
              className="border-b border-navy-900/5 last:border-0 px-4"
            >
              <AccordionTrigger className="text-left text-base font-semibold text-navy-900 py-5 hover:no-underline">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-navy-700 pb-5 leading-relaxed">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </MarketingSection>
  );
}
