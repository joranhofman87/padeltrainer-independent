import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

/* Mini Tailwind-built illustrations for each value prop */

function MiniCalendarGrid() {
  const slots = [1,1,0,1,1, 0,1,1,1,0, 1,0,1,1,1]; // 1=filled
  return (
    <div className="grid grid-cols-5 gap-1 w-fit" aria-hidden>
      {slots.map((filled, i) => (
        <div
          key={i}
          className={`h-3 w-5 rounded-sm ${filled ? 'bg-primary/70' : 'bg-muted'}`}
        />
      ))}
    </div>
  );
}

function MiniChecklist() {
  return (
    <div className="space-y-1.5 w-fit" aria-hidden>
      {[true, true, true, false].map((done, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div className={`h-3 w-3 rounded-sm border ${done ? 'bg-primary border-primary' : 'border-muted-foreground/30'}`}>
            {done && <svg viewBox="0 0 12 12" className="text-primary-foreground"><path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="2" fill="none" /></svg>}
          </div>
          <div className={`h-1.5 rounded-full ${done ? 'w-12 bg-muted-foreground/20 line-through' : 'w-16 bg-muted-foreground/30'}`} />
        </div>
      ))}
    </div>
  );
}


function MiniPhoneBooking() {
  return (
    <div className="w-14 rounded-lg border bg-card p-1.5 space-y-1" aria-hidden>
      <div className="h-1.5 w-8 rounded-full bg-primary/60" />
      <div className="h-1 w-10 rounded-full bg-muted" />
      <div className="h-4 rounded bg-primary/10 flex items-center justify-center">
        <div className="h-1.5 w-6 rounded-full bg-primary/40" />
      </div>
    </div>
  );
}

function MiniShield() {
  return (
    <div className="flex items-center gap-1.5 w-fit" aria-hidden>
      <div className="h-8 w-6 rounded-sm bg-primary/15 relative overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-5 bg-primary/30 rounded-sm" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-2 w-2 rounded-full bg-primary/60" />
        </div>
      </div>
      <div className="h-8 w-6 rounded-sm bg-destructive/10 relative overflow-hidden flex items-center justify-center">
        <div className="w-4 h-px bg-destructive/40 rotate-45" />
      </div>
    </div>
  );
}

const values = [
  { key: 'filled', Visual: MiniCalendarGrid },
  { key: 'admin', Visual: MiniChecklist },
  { key: 'noshows', Visual: MiniShield },
  { key: 'player', Visual: MiniPhoneBooking },
];

export function SolutionOverview() {
  const { t } = useTranslation('marketing');

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

        <div className="grid sm:grid-cols-2 gap-6">
          {values.map((v, i) => (
            <motion.div
              key={v.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              className="rounded-xl border bg-card p-6 flex items-start gap-5"
            >
              <div className="shrink-0 flex flex-col items-center gap-2">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                  <v.icon className="h-5 w-5 text-primary" />
                </div>
                <v.Visual />
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
