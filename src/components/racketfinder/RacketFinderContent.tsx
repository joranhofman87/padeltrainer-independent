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
    <div className="container max-w-4xl mx-auto px-4 pb-16 space-y-20">
      {/* How It Works */}
      <motion.section
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="text-center"
      >
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-10">
          {t('quiz.howItWorks.title', 'How It Works')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {steps.map((step, i) => (
            <div key={step.key} className="flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
                <step.icon className="h-7 w-7 text-primary" />
              </div>
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                {t(`quiz.howItWorks.${step.key}Label`, `Step ${i + 1}`)}
              </span>
              <h3 className="text-lg font-semibold text-foreground">
                {t(`quiz.howItWorks.${step.key}`, step.fallback)}
              </h3>
              <p className="text-sm text-muted-foreground max-w-xs">
                {t(`quiz.howItWorks.${step.key}Desc`, step.desc)}
              </p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* Why Use Our Finder */}
      <motion.section
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="text-center"
      >
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-10">
          {t('quiz.whyUse.title', 'Why Use Our Racket Finder?')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {valueProps.map((vp) => (
            <div key={vp.key} className="flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-accent/50 flex items-center justify-center">
                <vp.icon className="h-7 w-7 text-accent-foreground" />
              </div>
              <h3 className="text-lg font-semibold text-foreground">
                {t(`quiz.whyUse.${vp.key}`, vp.fallback)}
              </h3>
              <p className="text-sm text-muted-foreground max-w-xs">
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
