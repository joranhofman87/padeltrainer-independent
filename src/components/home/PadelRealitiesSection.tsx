import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

export function PadelRealitiesSection() {
  const { t } = useTranslation('marketing');

  const rows = ['chat', 'oncourt', 'noshows', 'payments', 'calendar', 'scale'];

  return (
    <section className="py-20 md:py-28">
      <div className="container mx-auto px-4">
        <motion.h2
          className="text-3xl md:text-4xl font-bold mb-12 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          {t('homev2.realities.headline')}
        </motion.h2>

        <div className="max-w-5xl mx-auto space-y-4">
          {/* Header row - desktop only */}
          <div className="hidden md:grid md:grid-cols-3 gap-4 text-sm font-semibold text-muted-foreground px-4">
            <span>{t('homev2.realities.col_pain')}</span>
            <span>{t('homev2.realities.col_solution')}</span>
            <span>{t('homev2.realities.col_outcome')}</span>
          </div>

          {rows.map((key, i) => (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
              className="grid md:grid-cols-3 gap-4 p-4 rounded-lg border bg-card hover:shadow-sm transition-shadow"
            >
              <div>
                <span className="md:hidden text-xs font-semibold text-muted-foreground">{t('homev2.realities.col_pain')}</span>
                <p className="text-foreground">{t(`homev2.realities.${key}_pain`)}</p>
              </div>
              <div>
                <span className="md:hidden text-xs font-semibold text-muted-foreground">{t('homev2.realities.col_solution')}</span>
                <p className="text-primary font-medium">{t(`homev2.realities.${key}_solution`)}</p>
              </div>
              <div>
                <span className="md:hidden text-xs font-semibold text-muted-foreground">{t('homev2.realities.col_outcome')}</span>
                <p className="text-muted-foreground">{t(`homev2.realities.${key}_outcome`)}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
