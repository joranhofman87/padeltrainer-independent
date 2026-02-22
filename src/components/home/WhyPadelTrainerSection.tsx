import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { Target, CreditCard, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function WhyPadelTrainerSection() {
  const { t } = useTranslation('marketing');

  const cards = [
    { icon: Target, key: 'focus' },
    { icon: CreditCard, key: 'paid' },
    { icon: Eye, key: 'visibility' },
  ];

  return (
    <section className="py-20 md:py-28">
      <div className="container mx-auto px-4">
        <motion.h2
          className="text-3xl md:text-4xl font-bold text-center mb-12 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          {t('homev2.whyPadelTrainer.headline')}
        </motion.h2>

        <div className="grid sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {cards.map((c, i) => (
            <motion.div
              key={c.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="h-full text-center hover:shadow-lg transition-shadow border-2 hover:border-primary/20">
                <CardContent className="p-6">
                  <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <c.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-semibold mb-2">{t(`homev2.whyPadelTrainer.${c.key}_title`)}</h3>
                  <p className="text-sm text-muted-foreground">{t(`homev2.whyPadelTrainer.${c.key}_desc`)}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
