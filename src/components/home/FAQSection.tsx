import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useTranslation } from 'react-i18next';

const FAQ_KEYS = [
  'onlyPadel', 'playersFree', 'trialHow', 'needWebsite',
  'onlineBooking', 'payments', 'calendarSync', 'europe', 'gdpr'
];

export function FAQSection() {
  const { t } = useTranslation('marketing');

  const faqItems = FAQ_KEYS.map(key => ({
    question: t(`homev2.faq.${key}_q`),
    answer: t(`homev2.faq.${key}_a`),
  }));

  // JSON-LD structured data
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };

  return (
    <section id="faq" className="py-24 md:py-32">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
        />

        <h2 className="font-display text-3xl md:text-[44px] font-extrabold tracking-[-0.02em] text-center mb-12 text-foreground">
          {t('homev2.faq.headline')}
        </h2>

        <Accordion type="single" collapsible className="w-full divide-y">
          {faqItems.map((item, i) => (
            <AccordionItem key={i} value={`faq-${i}`} className="border-b-0">
              <AccordionTrigger className="text-left text-base py-5">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground pb-5">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
