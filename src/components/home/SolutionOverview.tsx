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
    <section id="features" className="py-20 md:py-28 bg-muted/30">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          className="mb-14 max-w-2xl"
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

        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-10">
          {values.map((v, i) => (
            <motion.div
              key={v.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="flex items-start gap-4"
            >
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <v.icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">{t(`homev2.solution.value_${v.key}_title`)}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{t(`homev2.solution.value_${v.key}_desc`)}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
