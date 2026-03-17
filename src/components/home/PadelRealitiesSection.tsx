import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { getAppUrl } from '@/lib/domains';

const cardKeys = ['chat', 'oncourt', 'noshows', 'payments', 'calendar', 'scale'];

function ChaosChatMockup() {
  return (
    <div className="rounded-xl border bg-card/50 p-4 space-y-2.5 opacity-60 mt-8" aria-hidden>
      {/* Fake WhatsApp-style messages */}
      <div className="flex items-start gap-2">
        <div className="h-6 w-6 rounded-full bg-muted shrink-0" />
        <div className="space-y-1">
          <div className="rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground max-w-[180px]">
            Can I switch to Thursday? 🙏
          </div>
          <div className="text-[10px] text-muted-foreground/50">14:32</div>
        </div>
      </div>
      <div className="flex items-start gap-2 justify-end">
        <div className="space-y-1 text-right">
          <div className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs text-muted-foreground max-w-[160px]">
            Let me check the spreadsheet...
          </div>
          <div className="text-[10px] text-muted-foreground/50">14:45</div>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <div className="h-6 w-6 rounded-full bg-muted shrink-0" />
        <div className="space-y-1">
          <div className="rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground max-w-[200px]">
            I won't make it tomorrow, sorry 😅
          </div>
          <div className="text-[10px] text-muted-foreground/50">16:01</div>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <div className="h-6 w-6 rounded-full bg-muted shrink-0" />
        <div className="space-y-1">
          <div className="rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground max-w-[180px]">
            Did you get my payment yet?
          </div>
          <div className="text-[10px] text-muted-foreground/50">17:22</div>
        </div>
      </div>
      {/* Strike-through overlay */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-3/4 h-px bg-destructive/30 rotate-[-8deg]" />
      </div>
    </div>
  );
}

export function PadelRealitiesSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <div className="grid lg:grid-cols-[1fr,1.2fr] gap-12 items-start">
          {/* Left: sticky headline + chaos mockup */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="lg:sticky lg:top-32 relative"
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('homev2.realities.headline')}
            </h2>
            <p className="text-lg text-muted-foreground mb-6">
              {t('homev2.realities.intro')}
            </p>
            <Button size="lg" className="bg-primary hover:bg-primary/90" asChild>
              <Link to={getAppUrl('/signup/trainer')}>
                {t('homev2.cta.startTrial')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <div className="hidden lg:block relative">
              <ChaosChatMockup />
            </div>
          </motion.div>

          {/* Right: before/after list */}
          <div className="space-y-4">
            {cardKeys.map((key, i) => (
              <motion.div
                key={key}
                initial={{ opacity: 0, x: 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="rounded-xl border bg-card p-5"
              >
                <p className="text-sm text-muted-foreground line-through decoration-muted-foreground/40 mb-2">
                  {t(`homev2.realities.${key}_current`)}
                </p>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <p className="text-[15px] font-medium text-foreground">
                    {t(`homev2.realities.${key}_with`)}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
