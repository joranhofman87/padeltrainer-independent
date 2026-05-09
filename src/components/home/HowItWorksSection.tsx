import { CalendarPlus, Share2, Sparkles, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/* Mini visual mocks for each step — scaled up */

function MiniWeekCalendar() {
  const days = ['M', 'T', 'W', 'T', 'F'];
  const grid = [
    [0,1,0,1,0],
    [1,0,1,0,1],
    [0,1,0,0,1],
  ];
  return (
    <div className="rounded-xl border bg-card p-5 w-fit shadow-sm" aria-hidden>
      <div className="flex gap-4 mb-2">
        {days.map(d => (
          <span key={d} className="text-xs font-medium text-muted-foreground w-10 text-center">{d}</span>
        ))}
      </div>
      {grid.map((row, ri) => (
        <div key={ri} className="flex gap-4 mb-2">
          {row.map((slot, ci) => (
            <div
              key={ci}
              className={`h-7 w-10 rounded ${slot ? 'bg-primary/60' : 'bg-muted'}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function MiniShareLink() {
  return (
    <div className="rounded-xl border bg-card px-5 py-4 flex items-center gap-3 w-fit shadow-sm" aria-hidden>
      <div className="h-7 w-7 rounded bg-primary/20 flex items-center justify-center">
        <Share2 className="h-4 w-4 text-primary" />
      </div>
      <span className="text-sm text-muted-foreground font-mono">padeltrainer.ai/</span>
      <span className="text-sm text-primary font-mono font-medium">your-name</span>
    </div>
  );
}

function MiniNotification() {
  return (
    <div className="rounded-xl border bg-card px-5 py-4 flex items-center gap-3 w-fit shadow-sm" aria-hidden>
      <div className="h-10 w-10 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
        <Sparkles className="h-5 w-5 text-primary" />
      </div>
      <div>
        <p className="text-sm font-semibold text-foreground">New booking!</p>
        <p className="text-xs text-muted-foreground">Ana M. — Thu 18:00</p>
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
    <section id="how-it-works" className="py-16 md:py-24">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <h2 className="font-display text-3xl md:text-[44px] font-extrabold tracking-[-0.02em] mb-14 max-w-lg text-foreground">
          {t('homev2.howItWorks.headline')}
        </h2>

        <div className="grid md:grid-cols-3 gap-6 md:gap-4 relative">
          {/* Connecting dashed lines between steps (desktop only) */}
          <div className="hidden md:block absolute top-1/2 left-[calc(33.33%+8px)] right-[calc(66.67%-8px)] -translate-y-1/2 z-0" aria-hidden>
            <div className="border-t-2 border-dashed border-primary/20 w-full" />
            <ChevronRight className="h-4 w-4 text-primary/30 absolute -right-2 top-1/2 -translate-y-1/2" />
          </div>
          <div className="hidden md:block absolute top-1/2 left-[calc(66.67%+8px)] right-[calc(33.33%-8px)] -translate-y-1/2 z-0" aria-hidden>
            <div className="border-t-2 border-dashed border-primary/20 w-full" />
            <ChevronRight className="h-4 w-4 text-primary/30 absolute -right-2 top-1/2 -translate-y-1/2" />
          </div>

          {steps.map((s) => (
            <div key={s.key} className="relative z-10 bg-card rounded-xl shadow-sm p-8 border border-border/50">
              <span className="text-7xl md:text-8xl font-extrabold text-primary/15 mb-2 block leading-none">{s.num}</span>
              <div className="mb-5 min-h-[80px] flex items-center">
                <s.Visual />
              </div>
              <h3 className="text-xl font-semibold mb-2">{t(`homev2.howItWorks.${s.key}_title`)}</h3>
              <p className="text-muted-foreground leading-relaxed">{t(`homev2.howItWorks.${s.key}_desc`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
