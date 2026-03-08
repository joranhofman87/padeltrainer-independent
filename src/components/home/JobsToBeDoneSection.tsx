import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { GraduationCap, User, Building2, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';

export function JobsToBeDoneSection() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const getPath = useLocalizedPathFn();

  const personas = [
    { key: 'academy', icon: GraduationCap, bullets: 4, featured: false },
    { key: 'trainer', icon: User, bullets: 4, featured: true },
    { key: 'club', icon: Building2, bullets: 4, featured: false },
  ];

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
                  <div className={`h-10 w-10 rounded-lg flex items-center justify-center mb-4 ${p.featured ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                    <p.icon className="h-5 w-5" />
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
