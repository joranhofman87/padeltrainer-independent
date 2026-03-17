import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { GraduationCap, User, Building2, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';

/* Mini contextual illustrations per persona */

function MiniOrgChart() {
  return (
    <div className="flex flex-col items-center gap-1.5 py-2" aria-hidden>
      <div className="h-5 w-5 rounded-full bg-primary/30" />
      <div className="h-px w-6 bg-border" />
      <div className="flex gap-3">
        {[1,2,3].map(i => (
          <div key={i} className="h-4 w-4 rounded-full bg-muted-foreground/20" />
        ))}
      </div>
    </div>
  );
}

function MiniSchedule() {
  return (
    <div className="flex gap-1 py-2" aria-hidden>
      {[0.6, 0.3, 0.8, 0.5, 0.7].map((h, i) => (
        <div key={i} className="w-4 rounded-sm bg-primary/20 relative" style={{ height: `${h * 28 + 10}px` }}>
          <div className="absolute bottom-0 left-0 right-0 rounded-sm bg-primary/50" style={{ height: `${h * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

function MiniClubCourts() {
  return (
    <div className="flex gap-1.5 py-2" aria-hidden>
      {[1,2].map(i => (
        <div key={i} className="w-8 h-10 rounded border border-primary/20 bg-primary/5 flex items-center justify-center">
          <div className="w-5 h-px bg-primary/30" />
        </div>
      ))}
    </div>
  );
}

const personas = [
  { key: 'academy', icon: GraduationCap, bullets: 4, featured: false, Visual: MiniOrgChart },
  { key: 'trainer', icon: User, bullets: 4, featured: true, Visual: MiniSchedule },
  { key: 'club', icon: Building2, bullets: 4, featured: false, Visual: MiniClubCourts },
];

export function JobsToBeDoneSection() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const getPath = useLocalizedPathFn();

  return (
    <section className="py-20 md:py-28 bg-muted/30">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          className="mb-12 max-w-2xl"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            {t('homev2.jtbd.headline')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('homev2.jtbd.intro')}
          </p>
        </motion.div>

        <div className="grid sm:grid-cols-3 gap-6">
          {personas.map((p, i) => (
            <motion.div
              key={p.key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className={`h-full flex flex-col transition-shadow ${p.featured ? 'border-primary/40 shadow-lg' : 'hover:shadow-md'}`}>
                <CardContent className="p-6 flex flex-col flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${p.featured ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                      <p.icon className="h-5 w-5" />
                    </div>
                    <p.Visual />
                  </div>
                  <h3 className="text-lg font-semibold mb-1">{t(`homev2.jtbd.${p.key}_title`)}</h3>
                  <p className="text-sm text-muted-foreground mb-4">{t(`homev2.jtbd.${p.key}_subtitle`)}</p>
                  <ul className="space-y-2 mb-6 flex-1">
                    {Array.from({ length: p.bullets }, (_, bi) => (
                      <li key={bi} className="flex items-start gap-2 text-sm">
                        <Check className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                        <span>{t(`homev2.jtbd.${p.key}_b${bi + 1}`)}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="w-full mt-auto"
                    variant={p.featured ? 'default' : 'outline'}
                    onClick={() => navigate(getPath('/trainer/signup'))}
                  >
                    {t('homev2.jtbd.cta')}
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
