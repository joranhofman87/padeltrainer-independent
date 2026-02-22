import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { MessageSquare, Globe, UserX, CreditCard, Calendar, RefreshCw, ArrowRight, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const cardConfig = [
  { key: 'chat', icon: MessageSquare },
  { key: 'oncourt', icon: Globe },
  { key: 'noshows', icon: UserX },
  { key: 'payments', icon: CreditCard },
  { key: 'calendar', icon: Calendar },
  { key: 'scale', icon: RefreshCw },
];

export function PadelRealitiesSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          className="text-center mb-14"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            {t('homev2.realities.headline')}
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {t('homev2.realities.intro')}
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-5">
          {cardConfig.map((card, i) => {
            const Icon = card.icon;
            return (
              <motion.div
                key={card.key}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.06 }}
              >
                <Card className="h-full hover:shadow-md transition-all border hover:border-primary/20">
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      {/* Icon */}
                      <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
                        <Icon className="h-5 w-5 text-muted-foreground" />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        {/* Before */}
                        <div className="mb-3">
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                            {t('homev2.realities.label_before')}
                          </span>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {t(`homev2.realities.${card.key}_current`)}
                          </p>
                        </div>

                        {/* Arrow separator */}
                        <div className="flex items-center gap-2 mb-3">
                          <div className="h-px flex-1 bg-border" />
                          <ArrowRight className="h-3.5 w-3.5 text-primary shrink-0" />
                          <div className="h-px flex-1 bg-border" />
                        </div>

                        {/* After */}
                        <div className="rounded-md bg-emerald-500/5 border border-emerald-500/10 px-3 py-2 -mx-1">
                          <div className="flex items-center gap-1.5">
                            <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600/70 dark:text-emerald-400/70">
                              {t('homev2.realities.label_after')}
                            </span>
                          </div>
                          <p className="text-[15px] font-semibold text-foreground mt-0.5">
                            {t(`homev2.realities.${card.key}_with`)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>

        <motion.p
          className="text-center text-muted-foreground mt-10 font-medium"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
        >
          {t('homev2.realities.result')}
        </motion.p>
      </div>
    </section>
  );
}
