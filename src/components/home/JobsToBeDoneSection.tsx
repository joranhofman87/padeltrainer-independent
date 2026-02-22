import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

export function JobsToBeDoneSection() {
  const { t } = useTranslation('marketing');

  const jobs = ['selfbook', 'refill', 'group', 'payments', 'schedule', 'scale', 'locations'];

  return (
    <section className="py-20 md:py-28 bg-muted/30">
      <div className="container mx-auto px-4 max-w-3xl">
        <motion.h2
          className="text-3xl md:text-4xl font-bold mb-10"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          {t('homev2.jtbd.headline')}
        </motion.h2>

        <ul className="space-y-5">
          {jobs.map((key, i) => (
            <motion.li
              key={key}
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
              className="flex items-start gap-3 text-foreground"
            >
              <span className="mt-1 text-primary text-lg">→</span>
              <span className="text-lg">{t(`homev2.jtbd.job_${key}`)}</span>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}
