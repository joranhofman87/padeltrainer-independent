import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { getAppUrl } from '@/lib/domains';

const cardConfig = [
  { key: 'chat' },
  { key: 'oncourt' },
  { key: 'noshows' },
  { key: 'payments' },
  { key: 'calendar' },
  { key: 'scale' },
];

export function PadelRealitiesSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <div className="grid lg:grid-cols-[1fr,1.2fr] gap-12 items-start">
          {/* Left: sticky headline */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="lg:sticky lg:top-32"
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('homev2.realities.headline')}
            </h2>
            <p className="text-lg text-muted-foreground mb-6">
              {t('homev2.realities.intro')}
            </p>
            <Button size="lg" className="bg-primary hover:bg-primary/90" asChild>
              <Link to={getAppUrl('/signup/trainer')}>
                {t('homev2.cta.startTrial')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
          </motion.div>

          {/* Right: before/after list */}
          <div className="space-y-4">
            {cardConfig.map((card, i) => (
              <motion.div
                key={card.key}
                initial={{ opacity: 0, x: 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="rounded-xl border bg-card p-5"
              >
                <p className="text-sm text-muted-foreground line-through decoration-muted-foreground/40 mb-2">
                  {t(`homev2.realities.${card.key}_current`)}
                </p>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <p className="text-[15px] font-medium text-foreground">
                    {t(`homev2.realities.${card.key}_with`)}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
