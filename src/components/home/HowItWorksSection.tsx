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
    <section id="how-it-works" className="py-20 md:py-28 bg-muted/30">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          className="text-center mb-14"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">{t('homev2.howItWorks.headline')}</h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8">
          {steps.map((s, i) => (
            <motion.div
              key={s.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15 }}
              className="text-center"
            >
              <div className="h-16 w-16 rounded-full bg-primary text-primary-foreground text-2xl font-bold flex items-center justify-center mx-auto mb-4">
                <s.icon className="h-7 w-7" />
              </div>
              <h3 className="text-xl font-semibold mb-2">{t(`homev2.howItWorks.${s.key}_title`)}</h3>
              <p className="text-muted-foreground">{t(`homev2.howItWorks.${s.key}_desc`)}</p>
            </motion.div>
          ))}
        </div>

        <p className="text-center text-sm text-muted-foreground mt-10 max-w-xl mx-auto">
          {t('homev2.howItWorks.microcopy')}
        </p>
      </div>
    </section>
  );
}
