import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { ArrowRight, TrendingDown, Clock, HelpCircle, MessageCircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

export function ImpactSection() {
  const { t } = useTranslation('marketing');

  const impacts = [
    { icon: TrendingDown, key: 'revenue' },
    { icon: Clock, key: 'admin' },
    { icon: HelpCircle, key: 'noshows' },
    { icon: MessageCircleX, key: 'lateReply' },
  ];

  return (
    <section className="py-20 md:py-28 bg-muted/30">
      <div className="container mx-auto px-4 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-8">
            {t('homev2.impact.headline')}
          </h2>

          <ul className="space-y-5 mb-10">
            {impacts.map(item => (
              <li key={item.key} className="flex items-start gap-3">
                <item.icon className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
                <span className="text-foreground text-lg">{t(`homev2.impact.item_${item.key}`)}</span>
              </li>
            ))}
          </ul>

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
