import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function FinalCTASection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-24 md:py-32 bg-navy-950 text-white relative overflow-hidden">
      <div className="absolute inset-0 dot-grid opacity-20" aria-hidden />
      <div className="relative max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="max-w-2xl">
          <h2 className="font-display text-3xl md:text-[42px] font-extrabold tracking-[-0.02em] mb-4">
            {t('homev2.finalCta.headline')}
          </h2>
          <p className="text-lg text-white/70 mb-8 leading-relaxed">
            {t('homev2.finalCta.body')}
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              to={getAppUrl('/signup/trainer')}
              className="pill-primary text-base"
            >
              {t('homev2.cta.startTrial')}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </div>
          <p className="text-sm text-white/50 mt-4">
            {t('homev2.dualCta.microcopy')}
          </p>
        </div>
      </div>
    </section>
  );
}
