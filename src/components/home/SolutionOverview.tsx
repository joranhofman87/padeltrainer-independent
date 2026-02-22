import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { CalendarCheck, ClipboardMinus, ShieldCheck, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function SolutionOverview() {
  const { t } = useTranslation('marketing');

  const values = [
    { icon: CalendarCheck, key: 'filled' },
    { icon: ClipboardMinus, key: 'admin' },
    { icon: ShieldCheck, key: 'noshows' },
    { icon: Users, key: 'player' },
  ];

  return (
    <section id="features" className="py-20 md:py-28">
      <div className="container mx-auto px-4">
        <motion.div
          className="text-center mb-14 max-w-3xl mx-auto"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            {t('homev2.solution.headline')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('homev2.solution.category')}
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {values.map((v, i) => (
            <motion.div
              key={v.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="h-full text-center hover:shadow-lg transition-shadow border-2 hover:border-primary/20">
                <CardContent className="p-6">
                  <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <v.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-semibold mb-2">{t(`homev2.solution.value_${v.key}_title`)}</h3>
                  <p className="text-sm text-muted-foreground">{t(`homev2.solution.value_${v.key}_desc`)}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
