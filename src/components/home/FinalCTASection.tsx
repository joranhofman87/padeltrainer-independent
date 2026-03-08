import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function FinalCTASection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-20 md:py-28 bg-primary text-primary-foreground">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          className="max-w-2xl"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            {t('homev2.finalCta.headline')}
          </h2>
          <p className="text-lg text-primary-foreground/80 mb-8">
            {t('homev2.finalCta.body')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4">
            <Button size="lg" variant="secondary" className="text-lg px-8 h-14" asChild>
              <Link to={getAppUrl('/signup/trainer')}>
                {t('homev2.cta.startTrial')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
          </div>
          <p className="text-sm text-primary-foreground/60 mt-4">
            {t('homev2.cta.trustMicrocopy')}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
