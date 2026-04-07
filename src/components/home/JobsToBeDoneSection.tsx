import { Card, CardContent } from '@/components/ui/card';
import { GraduationCap, User, Building2, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';

const personas = [
  { key: 'academy', icon: GraduationCap, bullets: 4, featured: false },
  { key: 'trainer', icon: User, bullets: 4, featured: true },
  { key: 'club', icon: Building2, bullets: 4, featured: false },
];

export function JobsToBeDoneSection() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const getPath = useLocalizedPathFn();

  return (
    <section className="py-24 md:py-32 section-alt">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl md:text-[42px] font-bold tracking-[-0.02em] mb-4 text-foreground">
            {t('homev2.jtbd.headline')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('homev2.jtbd.intro')}
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-6">
          {personas.map((p) => (
            <div key={p.key}>
              <Card className={`h-full flex flex-col transition-all duration-200 border-0 ${
                p.featured
                  ? 'scale-[1.02] shadow-lg border-2 border-primary'
                  : 'shadow-sm hover:shadow-md'
              }`}>
                <CardContent className="p-8 flex flex-col flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${p.featured ? 'bg-primary text-primary-foreground' : 'bg-primary/10'}`}>
                      <p.icon className="h-5 w-5" />
                    </div>
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
                    className="w-full mt-auto rounded-lg"
                    variant={p.featured ? 'default' : 'outline'}
                    onClick={() => navigate(getPath('/trainer/signup'))}
                  >
                    {t('homev2.jtbd.cta')}
                  </Button>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
