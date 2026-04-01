import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
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
    <section className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-12">
            {t('homev2.pain.headline')}
          </h2>
        </motion.div>

        <div className="space-y-8 mb-12">
          {painItems.map((item, i) => (
            <motion.div
              key={item.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
              className="rounded-xl border bg-card p-6 md:p-8"
            >
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-lg bg-destructive/10 flex items-center justify-center shrink-0">
                  <item.icon className="h-5 w-5 text-destructive" />
                </div>
                <div className="space-y-3">
                  <p className="text-foreground leading-relaxed">
                    {t(`homev2.pain.${item.key}_story`)}
                  </p>
                  <p className="text-primary font-medium">
                    {t(`homev2.pain.${item.key}_solution`)}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        <Button size="lg" className="bg-primary hover:bg-primary/90" asChild>
          <Link to={getAppUrl('/signup/trainer')}>
            {t('homev2.cta.startTrial')}
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
