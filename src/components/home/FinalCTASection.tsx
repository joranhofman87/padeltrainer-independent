import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function FinalCTASection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-16 md:py-24 lg:py-32 bg-navy-950 text-white relative overflow-hidden">
      <div className="absolute inset-0 dot-grid opacity-20" aria-hidden />
      <div className="relative max-w-7xl mx-auto px-4 md:px-6 text-center">
        <div className="max-w-3xl mx-auto">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 ring-1 ring-white/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white/80">
            {t('homev2.finalCta.eyebrow', 'Ready when you are')}
          </span>
          <h2 className="mt-5 font-display text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-[-0.02em] leading-[1.05]">
            {t('homev2.finalCta.headline')}
          </h2>
          <p className="mt-6 text-lg text-white/70 leading-relaxed max-w-2xl mx-auto">
            {t('homev2.finalCta.body')}
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link to={getAppUrl('/signup/trainer')} className="pill-primary text-base">
              {t('homev2.cta.startTrial')}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </div>
          <p className="mt-4 text-sm text-white/50">{t('homev2.dualCta.microcopy')}</p>
        </div>
      </div>
    </section>
  );
}
