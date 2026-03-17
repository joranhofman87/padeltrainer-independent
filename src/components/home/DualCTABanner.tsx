import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';

export function DualCTABanner() {
  const { t } = useTranslation('marketing');
  const getPath = useLocalizedPathFn();

  return (
    <section className="py-20 md:py-28 bg-primary text-primary-foreground">
      <div className="max-w-4xl mx-auto px-4 md:px-6 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-3">
            {t('homev2.dualCta.headline')}
          </h2>
          <p className="text-lg text-primary-foreground/80 mb-10 max-w-2xl mx-auto">
            {t('homev2.dualCta.body')}
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button size="lg" variant="secondary" className="text-lg px-8 h-14" asChild>
              <Link to={getAppUrl('/signup/trainer')}>
                {t('homev2.dualCta.trainerCta')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="text-lg px-8 h-14 bg-transparent border-2 border-primary-foreground text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
              asChild
            >
              <Link to={getPath('/app/signup/player')}>
                {t('homev2.dualCta.playerCta')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
          </div>

          <p className="text-sm text-primary-foreground/60 mt-5">
            {t('homev2.dualCta.microcopy')}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
