import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { ArrowRight, Play, Calendar, CreditCard, Bell, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { trackEvent } from '@/lib/tracking';

const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5 }
};

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.1 } }
};

export function HeroSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-secondary/5 pointer-events-none" />
      <div className="absolute top-20 right-10 w-72 h-72 bg-primary/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-6xl mx-auto px-4 md:px-6 py-20 md:py-28">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Left: Copy */}
          <motion.div initial="initial" animate="animate" variants={staggerContainer}>
            <motion.h1
              variants={fadeInUp}
              className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight mb-6"
            >
              {t('homev2.hero.h1')}
            </motion.h1>

            <motion.p variants={fadeInUp} className="text-lg md:text-xl text-muted-foreground mb-8 max-w-xl">
              {t('homev2.hero.subheadline')}
            </motion.p>

            <motion.ul variants={fadeInUp} className="space-y-3 mb-8 text-foreground">
              {[1, 2, 3].map(i => (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-primary flex-shrink-0" />
                  <span>{t(`homev2.hero.bullet${i}`)}</span>
                </li>
              ))}
            </motion.ul>

            <motion.div variants={fadeInUp} className="flex flex-col sm:flex-row gap-3 mb-4">
              <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
                <Link to={getAppUrl('/signup/trainer')} onClick={() => trackEvent('cta_clicked', { location: 'hero' })}>
                  {t('homev2.cta.startTrial')}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="text-lg px-8 h-14 border-2" asChild>
                <a href="#how-it-works">
                  <Play className="mr-2 h-4 w-4" />
                  {t('homev2.cta.watchDemo')}
                </a>
              </Button>
            </motion.div>

            <motion.p variants={fadeInUp} className="text-sm text-muted-foreground">
              {t('homev2.cta.trustMicrocopy')}
            </motion.p>
          </motion.div>

          {/* Right: Product screenshot placeholder */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="hidden lg:block"
          >
            <div className="relative rounded-xl border-2 border-border bg-card shadow-2xl overflow-hidden">
              <div className="bg-muted/50 px-4 py-3 border-b flex items-center gap-2">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-destructive/40" />
                  <div className="h-3 w-3 rounded-full bg-primary/40" />
                  <div className="h-3 w-3 rounded-full bg-green-500/40" />
                </div>
                <span className="text-xs text-muted-foreground ml-2">padeltrainer.ai</span>
              </div>
              <div className="p-6 space-y-4 min-h-[320px]">
                {/* Mock agenda UI */}
                <div className="flex items-center gap-2 mb-4">
                  <Calendar className="h-5 w-5 text-primary" />
                  <span className="font-semibold">{t('homev2.hero.mockAgenda')}</span>
                </div>
                {[
                  { time: '09:00', label: 'Private lesson — Ana M.', status: 'confirmed' },
                  { time: '10:30', label: 'Group (4p) — Beginners', status: 'confirmed' },
                  { time: '14:00', label: 'Private lesson — Open slot', status: 'open' },
                  { time: '16:00', label: 'Group (4p) — Intermediate', status: 'confirmed' },
                ].map((slot, i) => (
                  <div key={i} className={`flex items-center gap-3 p-3 rounded-lg border ${slot.status === 'open' ? 'border-dashed border-primary/50 bg-primary/5' : 'bg-muted/30'}`}>

                    <span className="text-sm font-mono text-muted-foreground w-12">{slot.time}</span>
                    <span className="text-sm flex-1">{slot.label}</span>
                    {slot.status === 'confirmed' && <span className="text-xs text-primary-foreground bg-primary/60 px-2 py-0.5 rounded">✓</span>}
                    {slot.status === 'open' && <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">{t('homev2.hero.openSlot')}</span>}
                  </div>
                ))}
              </div>
            </div>
            {/* Feature pills below screenshot */}
            <div className="flex flex-wrap gap-2 mt-4 justify-center">
              {[
                { icon: Calendar, label: t('homev2.hero.pill1') },
                { icon: CreditCard, label: t('homev2.hero.pill2') },
                { icon: Bell, label: t('homev2.hero.pill3') },
                { icon: Mail, label: t('homev2.hero.pill4') },
              ].map((pill, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full">
                  <pill.icon className="h-3 w-3" />
                  {pill.label}
                </span>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
