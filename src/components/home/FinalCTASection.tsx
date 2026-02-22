import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { ArrowRight, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function FinalCTASection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-20 md:py-28 bg-accent text-accent-foreground">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          className="text-center max-w-2xl mx-auto"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            {t('homev2.finalCta.headline')}
          </h2>
          <p className="text-lg text-accent-foreground/80 mb-8">
            {t('homev2.finalCta.body')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center mb-4">
            <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
              <Link to={getAppUrl('/signup/trainer')}>
                {t('homev2.cta.startTrial')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <Button size="lg" variant="secondary" className="text-lg px-8 h-14" asChild>
              <a href="#how-it-works">
                <Play className="mr-2 h-4 w-4" />
                {t('homev2.cta.watchDemo')}
              </a>
            </Button>
          </div>
          <p className="text-sm text-accent-foreground/60">
            {t('homev2.cta.trustMicrocopy')}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
