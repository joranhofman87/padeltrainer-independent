import { motion } from 'framer-motion';
import { CalendarPlus, Share2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/* Mini visual mocks for each step */

function MiniWeekCalendar() {
  const days = ['M', 'T', 'W', 'T', 'F'];
  const grid = [
    [0,1,0,1,0],
    [1,0,1,0,1],
    [0,1,0,0,1],
  ];
  return (
    <div className="rounded-lg border bg-card p-3 w-fit" aria-hidden>
      <div className="flex gap-2 mb-2">
        {days.map(d => (
          <span key={d} className="text-[9px] font-medium text-muted-foreground w-6 text-center">{d}</span>
        ))}
      </div>
      {grid.map((row, ri) => (
        <div key={ri} className="flex gap-2 mb-1">
          {row.map((slot, ci) => (
            <div
              key={ci}
              className={`h-3.5 w-6 rounded-sm ${slot ? 'bg-primary/60' : 'bg-muted'}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function MiniShareLink() {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 flex items-center gap-2 w-fit" aria-hidden>
      <div className="h-4 w-4 rounded bg-primary/20 flex items-center justify-center">
        <Share2 className="h-2.5 w-2.5 text-primary" />
      </div>
      <span className="text-[10px] text-muted-foreground font-mono">padeltrainer.ai/</span>
      <span className="text-[10px] text-primary font-mono font-medium">your-name</span>
    </div>
  );
}

function MiniNotification() {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 flex items-center gap-2.5 w-fit" aria-hidden>
      <div className="h-6 w-6 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
        <Sparkles className="h-3 w-3 text-primary" />
      </div>
      <div>
        <p className="text-[10px] font-semibold text-foreground">New booking!</p>
        <p className="text-[9px] text-muted-foreground">Ana M. — Thu 18:00</p>
      </div>
    </div>
  );
}

const steps = [
  { icon: CalendarPlus, num: '1', key: 'step1', Visual: MiniWeekCalendar },
  { icon: Share2, num: '2', key: 'step2', Visual: MiniShareLink },
  { icon: Sparkles, num: '3', key: 'step3', Visual: MiniNotification },
];

export function HowItWorksSection() {
  const { t } = useTranslation('marketing');

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
              <div className="mb-4 h-[52px] flex items-center">
                <s.Visual />
              </div>
              <h3 className="text-xl font-semibold mb-2">{t(`homev2.howItWorks.${s.key}_title`)}</h3>
              <p className="text-muted-foreground leading-relaxed">{t(`homev2.howItWorks.${s.key}_desc`)}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
