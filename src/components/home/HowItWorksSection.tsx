import { CalendarPlus, Share2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const steps = [
  { icon: CalendarPlus, num: '01', key: 'step1' },
  { icon: Share2, num: '02', key: 'step2' },
  { icon: Sparkles, num: '03', key: 'step3' },
];

export function HowItWorksSection() {
  const { t } = useTranslation('marketing');

  return (
    <section id="how-it-works" className="py-24 md:py-32 bg-white">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="max-w-3xl mb-14">
          <span className="eyebrow">{t('homev2.howItWorks.eyebrow', 'How it works')}</span>
          <h2 className="mt-4 font-display text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {t('homev2.howItWorks.headline')}
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {steps.map((s) => (
            <div key={s.key} className="card-chip p-7 relative">
              <span className="absolute top-6 right-7 text-5xl font-display font-extrabold text-brand-500/15 leading-none">
                {s.num}
              </span>
              <div className="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
                <s.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 font-display font-bold text-xl text-navy-900">
                {t(`homev2.howItWorks.${s.key}_title`)}
              </h3>
              <p className="mt-3 text-navy-700 leading-relaxed">
                {t(`homev2.howItWorks.${s.key}_desc`)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
