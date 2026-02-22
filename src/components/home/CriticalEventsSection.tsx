import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { ArrowRight, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function CriticalEventsSection() {
  const { t } = useTranslation('marketing');

  const events = ['season', 'independent', 'noshows', 'volume', 'fulltime'];

  return (
    <section className="py-20 md:py-28">
      <div className="container mx-auto px-4 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-8">{t('homev2.criticalEvents.headline')}</h2>

          <ul className="space-y-4 mb-8">
            {events.map(key => (
              <li key={key} className="flex items-start gap-3">
                <Zap className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <span className="text-lg text-foreground">{t(`homev2.criticalEvents.event_${key}`)}</span>
              </li>
            ))}
          </ul>

          <p className="text-lg text-muted-foreground mb-6">{t('homev2.criticalEvents.closing')}</p>

          <Button size="lg" className="bg-primary hover:bg-primary/90" asChild>
            <Link to={getAppUrl('/signup/trainer')}>
              {t('homev2.cta.startTrial')}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </Button>
        </motion.div>
      </div>
    </section>
  );
}
