import { motion } from 'framer-motion';
import { CalendarPlus, Share2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function HowItWorksSection() {
  const { t } = useTranslation('marketing');

  const steps = [
    { icon: CalendarPlus, num: '1', key: 'step1' },
    { icon: Share2, num: '2', key: 'step2' },
    { icon: Sparkles, num: '3', key: 'step3' },
  ];

  return (
    <section id="how-it-works" className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.h2
          className="text-3xl md:text-4xl font-bold mb-14 max-w-lg"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          {t('homev2.howItWorks.headline')}
        </motion.h2>

        <div className="grid md:grid-cols-3 gap-12">
          {steps.map((s, i) => (
            <motion.div
              key={s.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12 }}
            >
              <span className="text-5xl font-bold text-primary/20 mb-3 block">{s.num}</span>
              <h3 className="text-xl font-semibold mb-2">{t(`homev2.howItWorks.${s.key}_title`)}</h3>
              <p className="text-muted-foreground leading-relaxed">{t(`homev2.howItWorks.${s.key}_desc`)}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
