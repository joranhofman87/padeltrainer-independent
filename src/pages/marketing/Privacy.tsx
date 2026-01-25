import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

export default function Privacy() {
  const { t, i18n } = useTranslation('marketing');

  const dateLocale = i18n.language === 'nl' ? 'nl-NL' : 'en-US';
  const formattedDate = new Date().toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' });

  const s = (key: string) => t(`privacy.sections.${key}`);

  return (
    <MarketingLayout>
      <div className="container mx-auto px-4 py-16 max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-4xl font-bold mb-8">{t('privacy.title')}</h1>
          <p className="text-muted-foreground mb-8">
            {t('privacy.lastUpdated', { date: formattedDate })}
          </p>

          <div className="prose prose-lg max-w-none space-y-8">
            {/* 1. Introduction */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('introduction.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('introduction.content')}
              </p>
            </section>

            {/* 2. Information We Collect */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('dataCollection.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('dataCollection.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>{s('dataCollection.items.account').split(':')[0]}:</strong>{s('dataCollection.items.account').split(':').slice(1).join(':')}</li>
                <li><strong>{s('dataCollection.items.profile').split(':')[0]}:</strong>{s('dataCollection.items.profile').split(':').slice(1).join(':')}</li>
                <li><strong>{s('dataCollection.items.booking').split(':')[0]}:</strong>{s('dataCollection.items.booking').split(':').slice(1).join(':')}</li>
                <li><strong>{s('dataCollection.items.payment').split(':')[0]}:</strong>{s('dataCollection.items.payment').split(':').slice(1).join(':')}</li>
                <li><strong>{s('dataCollection.items.communications').split(':')[0]}:</strong>{s('dataCollection.items.communications').split(':').slice(1).join(':')}</li>
              </ul>
            </section>

            {/* 3. How We Use Your Information */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('usage.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('usage.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>{s('usage.items.provide')}</li>
                <li>{s('usage.items.process')}</li>
                <li>{s('usage.items.send')}</li>
                <li>{s('usage.items.facilitate')}</li>
                <li>{s('usage.items.support')}</li>
                <li>{s('usage.items.promo')}</li>
                <li>{s('usage.items.analyze')}</li>
                <li>{s('usage.items.prevent')}</li>
              </ul>
            </section>

            {/* 4. Information Sharing */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('sharing.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('sharing.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>{s('sharing.items.users').split(':')[0]}:</strong>{s('sharing.items.users').split(':').slice(1).join(':')}</li>
                <li><strong>{s('sharing.items.providers').split(':')[0]}:</strong>{s('sharing.items.providers').split(':').slice(1).join(':')}</li>
                <li><strong>{s('sharing.items.legal').split(':')[0]}:</strong>{s('sharing.items.legal').split(':').slice(1).join(':')}</li>
                <li><strong>{s('sharing.items.business').split(':')[0]}:</strong>{s('sharing.items.business').split(':').slice(1).join(':')}</li>
              </ul>
            </section>

            {/* 5. Cookies and Tracking */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('cookies.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('cookies.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>{s('cookies.items.login')}</li>
                <li>{s('cookies.items.preferences')}</li>
                <li>{s('cookies.items.analyze')}</li>
                <li>{s('cookies.items.improve')}</li>
              </ul>
              <p className="text-muted-foreground leading-relaxed mt-4">
                {s('cookies.control')}
              </p>
            </section>

            {/* 6. Data Security */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('security.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('security.content')}
              </p>
            </section>

            {/* 7. Your Rights (GDPR) */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('gdpr.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('gdpr.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>{s('gdpr.items.access').split(':')[0]}:</strong>{s('gdpr.items.access').split(':').slice(1).join(':')}</li>
                <li><strong>{s('gdpr.items.rectification').split(':')[0]}:</strong>{s('gdpr.items.rectification').split(':').slice(1).join(':')}</li>
                <li><strong>{s('gdpr.items.erasure').split(':')[0]}:</strong>{s('gdpr.items.erasure').split(':').slice(1).join(':')}</li>
                <li><strong>{s('gdpr.items.restriction').split(':')[0]}:</strong>{s('gdpr.items.restriction').split(':').slice(1).join(':')}</li>
                <li><strong>{s('gdpr.items.portability').split(':')[0]}:</strong>{s('gdpr.items.portability').split(':').slice(1).join(':')}</li>
                <li><strong>{s('gdpr.items.objection').split(':')[0]}:</strong>{s('gdpr.items.objection').split(':').slice(1).join(':')}</li>
                <li><strong>{s('gdpr.items.withdraw').split(':')[0]}:</strong>{s('gdpr.items.withdraw').split(':').slice(1).join(':')}</li>
              </ul>
              <p className="text-muted-foreground leading-relaxed mt-4">
                {s('gdpr.contact')}
              </p>
            </section>

            {/* 8. Data Retention */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('retention.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('retention.content')}
              </p>
            </section>

            {/* 9. Children's Privacy */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('children.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('children.content')}
              </p>
            </section>

            {/* 10. Changes to This Policy */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('changes.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('changes.content')}
              </p>
            </section>

            {/* 11. Contact Us */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('contact.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('contact.content')}
              </p>
              <div className="bg-accent rounded-lg p-6 mt-4">
                <p className="text-foreground font-medium">{s('contact.company')}</p>
                <p className="text-muted-foreground">{s('contact.emailPrivacy')}</p>
                <p className="text-muted-foreground">{s('contact.emailGeneral')}</p>
              </div>
            </section>
          </div>
        </motion.div>
      </div>
    </MarketingLayout>
  );
}