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

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };

  return (
    <section id="faq" className="py-24 md:py-32 section-cream">
      <div className="max-w-3xl mx-auto px-4 md:px-6">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />

        <div className="text-center mb-14">
          <span className="eyebrow">{t('homev2.faq.eyebrow', 'Questions')}</span>
          <h2 className="mt-4 font-display text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {t('homev2.faq.headline')}
          </h2>
        </div>

        <div className="card-chip p-2 md:p-4">
          <Accordion type="single" collapsible className="w-full">
            {faqItems.map((item, i) => (
              <AccordionItem key={i} value={`faq-${i}`} className="border-b border-navy-900/5 last:border-0 px-4">
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
      </div>
    </section>
  );
}
