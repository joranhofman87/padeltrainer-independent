import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function FinalCTASection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-24 md:py-32 bg-[hsl(var(--brand-navy))] text-white">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="max-w-2xl">
          <h2 className="text-3xl md:text-[42px] font-bold tracking-[-0.02em] mb-4">
            {t('homev2.finalCta.headline')}
          </h2>
          <p className="text-lg text-white/70 mb-8">
            {t('homev2.finalCta.body')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <Button size="lg" className="text-lg px-10 h-16 rounded-lg bg-primary hover:bg-primary/90 shadow-lg" asChild>
              <Link to={getAppUrl('/signup/trainer')}>
                {t('homev2.cta.startTrial')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
          </div>
          <p className="text-sm text-white/50 mt-4">
            {t('homev2.dualCta.microcopy')}
          </p>
        </div>
      </div>
    </section>
  );
}
