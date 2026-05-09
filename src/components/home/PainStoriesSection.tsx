import { Link } from 'react-router-dom';
import { ArrowRight, MessageSquare, CalendarX, Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

const painItems = [
  { key: 'whatsapp', icon: MessageSquare },
  { key: 'cancellation', icon: CalendarX },
  { key: 'payments', icon: Receipt },
];

export function PainStoriesSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-24 md:py-32 section-cream">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="max-w-3xl mb-14">
          <span className="eyebrow">{t('homev2.pain.eyebrow', 'The daily grind')}</span>
          <h2 className="mt-4 font-display text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {t('homev2.pain.headline')}
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6 mb-12">
          {painItems.map((item) => (
            <div key={item.key} className="card-chip p-7 flex flex-col">
              <div className="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                <item.icon className="h-5 w-5" />
              </div>
              <p className="mt-5 text-navy-700 leading-relaxed flex-1">
                {t(`homev2.pain.${item.key}_story`)}
              </p>
              <p className="mt-5 pt-5 border-t border-navy-900/5 text-navy-900 font-semibold">
                {t(`homev2.pain.${item.key}_solution`)}
              </p>
            </div>
          ))}
        </div>

        <Link to={getAppUrl('/signup/trainer')} className="pill-primary">
          {t('homev2.cta.startTrial')}
          <ArrowRight className="ml-2 h-5 w-5" />
        </Link>
      </div>
    </section>
  );
}
