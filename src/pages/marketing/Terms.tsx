import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

export default function Terms() {
  const { t, i18n } = useTranslation('marketing');

  const dateLocale = i18n.language === 'nl' ? 'nl-NL' : 'en-US';
  const formattedDate = new Date().toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' });

  const s = (key: string) => t(`terms.sections.${key}`);

  return (
    <MarketingLayout>
      <div className="container mx-auto px-4 py-16 max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-4xl font-bold mb-8">{t('terms.title')}</h1>
          <p className="text-muted-foreground mb-8">
            {t('terms.lastUpdated', { date: formattedDate })}
          </p>

          <div className="prose prose-lg max-w-none space-y-8">
            {/* 1. Agreement to Terms */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('agreement.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('agreement.content')}
              </p>
            </section>

            {/* 2. Description of Service */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('description.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('description.content')}
              </p>
            </section>

            {/* 3. User Accounts */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('accounts.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('accounts.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>{s('accounts.items.confidentiality')}</li>
                <li>{s('accounts.items.access')}</li>
                <li>{s('accounts.items.activities')}</li>
                <li>{s('accounts.items.notify')}</li>
              </ul>
            </section>

            {/* 4. For Players */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('players.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('players.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>{s('players.items.accurate')}</li>
                <li>{s('players.items.pay')}</li>
                <li>{s('players.items.arrive')}</li>
                <li>{s('players.items.respect')}</li>
                <li>{s('players.items.cancellation')}</li>
                <li>{s('players.items.reviews')}</li>
              </ul>
            </section>

            {/* 5. For Trainers */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('trainers.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('trainers.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>{s('trainers.items.qualifications')}</li>
                <li>{s('trainers.items.certifications')}</li>
                <li>{s('trainers.items.bookings')}</li>
                <li>{s('trainers.items.quality')}</li>
                <li>{s('trainers.items.respond')}</li>
                <li>{s('trainers.items.comply')}</li>
                <li>{s('trainers.items.fees')}</li>
              </ul>
            </section>

            {/* 6. Payments and Fees */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('payments.title')}</h2>
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-medium mb-2">{s('payments.forPlayers.title')}</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {s('payments.forPlayers.content')}
                  </p>
                </div>
                <div>
                  <h3 className="text-lg font-medium mb-2">{s('payments.forTrainers.title')}</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {s('payments.forTrainers.content')}
                  </p>
                </div>
              </div>
            </section>

            {/* 7. Cancellation Policy */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('cancellation.title')}</h2>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>{s('cancellation.items.24h').split(':')[0]}:</strong>{s('cancellation.items.24h').split(':').slice(1).join(':')}</li>
                <li><strong>{s('cancellation.items.12h').split(':')[0]}:</strong>{s('cancellation.items.12h').split(':').slice(1).join(':')}</li>
                <li><strong>{s('cancellation.items.less12h').split(':')[0]}:</strong>{s('cancellation.items.less12h').split(':').slice(1).join(':')}</li>
                <li><strong>{s('cancellation.items.trainer').split(':')[0]}:</strong>{s('cancellation.items.trainer').split(':').slice(1).join(':')}</li>
              </ul>
              <p className="text-muted-foreground leading-relaxed mt-4">
                {s('cancellation.note')}
              </p>
            </section>

            {/* 8. Intellectual Property */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('ip.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('ip.content')}
              </p>
            </section>

            {/* 9. User Content */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('userContent.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('userContent.content')}
              </p>
            </section>

            {/* 10. Prohibited Activities */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('prohibited.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('prohibited.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>{s('prohibited.items.illegal')}</li>
                <li>{s('prohibited.items.harass')}</li>
                <li>{s('prohibited.items.false')}</li>
                <li>{s('prohibited.items.circumvent')}</li>
                <li>{s('prohibited.items.scrape')}</li>
                <li>{s('prohibited.items.malicious')}</li>
                <li>{s('prohibited.items.impersonate')}</li>
                <li>{s('prohibited.items.spam')}</li>
              </ul>
            </section>

            {/* 11. Disclaimer of Warranties */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('disclaimer.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('disclaimer.content')}
              </p>
            </section>

            {/* 12. Limitation of Liability */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('liability.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('liability.content')}
              </p>
            </section>

            {/* 13. Indemnification */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('indemnification.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('indemnification.content')}
              </p>
            </section>

            {/* 14. Dispute Resolution */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('disputes.title')}</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                {s('disputes.intro')}
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>{s('disputes.items.users').split(':')[0]}:</strong>{s('disputes.items.users').split(':').slice(1).join(':')}</li>
                <li><strong>{s('disputes.items.platform').split(':')[0]}:</strong>{s('disputes.items.platform').split(':').slice(1).join(':')}</li>
              </ul>
            </section>

            {/* 15. Termination */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('termination.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('termination.content')}
              </p>
            </section>

            {/* 16. Changes to Terms */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('changes.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('changes.content')}
              </p>
            </section>

            {/* 17. Governing Law */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('governing.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('governing.content')}
              </p>
            </section>

            {/* 18. Contact Us */}
            <section>
              <h2 className="text-2xl font-semibold mb-4">{s('contact.title')}</h2>
              <p className="text-muted-foreground leading-relaxed">
                {s('contact.content')}
              </p>
              <div className="bg-accent rounded-lg p-6 mt-4">
                <p className="text-foreground font-medium">{s('contact.company')}</p>
                <p className="text-muted-foreground">{s('contact.emailLegal')}</p>
                <p className="text-muted-foreground">{s('contact.emailGeneral')}</p>
              </div>
            </section>
          </div>
        </motion.div>
      </div>
    </MarketingLayout>
  );
}