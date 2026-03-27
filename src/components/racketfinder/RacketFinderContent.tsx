import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ClipboardList, Sparkles, ShoppingBag, Target, Clock, Shield } from 'lucide-react';

const steps = [
  { icon: ClipboardList, key: 'step1', fallback: 'Answer 5 quick questions', desc: 'Tell us about your level, style, budget, and preferences.' },
  { icon: Sparkles, key: 'step2', fallback: 'Get matched instantly', desc: 'Our algorithm finds the best rackets from our curated catalogue.' },
  { icon: ShoppingBag, key: 'step3', fallback: 'Buy with confidence', desc: 'Check prices, read reviews, and purchase from trusted shops.' },
];

const valueProps = [
  { icon: Target, key: 'accurate', fallback: 'Accurate Matching', desc: 'Filters by level, style, shape, weight, budget & arm health.' },
  { icon: Clock, key: 'fast', fallback: 'Under 60 Seconds', desc: 'No signup required. Get results in under a minute.' },
  { icon: Shield, key: 'independent', fallback: 'Independent Advice', desc: 'We recommend based on specs and reviews, not sponsorships.' },
];

export default function RacketFinderContent() {
  const { t } = useTranslation('marketing');
  const { lang = 'en' } = useParams<{ lang: string }>();

  return (
    <div className="container max-w-4xl mx-auto px-4 pb-16 space-y-24">
      {/* How It Works */}
      <motion.section
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="text-center"
      >
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-14">
          {t('quiz.howItWorks.title', 'How It Works')}
        </h2>
        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-6">
          {/* Timeline connector (desktop only) */}
          <div className="hidden md:block absolute top-7 left-[calc(16.67%+28px)] right-[calc(16.67%+28px)] h-0.5 bg-border" />

          {steps.map((step, i) => (
            <div key={step.key} className="relative flex flex-col items-center gap-4">
              {/* Numbered circle */}
              <div className="relative z-10 w-14 h-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-lg font-bold shadow-md">
                {i + 1}
              </div>
              <h3 className="text-lg font-semibold text-foreground">
                {t(`quiz.howItWorks.${step.key}`, step.fallback)}
              </h3>
              <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
                {t(`quiz.howItWorks.${step.key}Desc`, step.desc)}
              </p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* Why Use Our Finder */}
      <motion.section
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="text-center"
      >
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-14">
          {t('quiz.whyUse.title', 'Why Use Our Racket Finder?')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {valueProps.map((vp) => (
            <div key={vp.key} className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 shadow-sm">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <vp.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">
                {t(`quiz.whyUse.${vp.key}`, vp.fallback)}
              </h3>
              <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
                {t(`quiz.whyUse.${vp.key}Desc`, vp.desc)}
              </p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* Browse All */}
      <div className="text-center">
        <a
          href={`/${lang}/gear/rackets`}
          className="text-primary font-medium underline underline-offset-4 hover:text-primary/80 transition-colors"
        >
          {t('quiz.browseAll', 'Browse All Rackets →')}
        </a>
      </div>
    </div>
  );
}
