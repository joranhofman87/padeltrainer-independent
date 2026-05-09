import { GraduationCap, User, Building2, Check, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
    <section className="py-24 md:py-32 section-cream">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="max-w-3xl mb-14">
          <span className="eyebrow">{t('homev2.jtbd.eyebrow', 'Built for your role')}</span>
          <h2 className="mt-4 font-display text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {t('homev2.jtbd.headline')}
          </h2>
          <p className="mt-5 text-lg text-navy-700">
            {t('homev2.jtbd.intro')}
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {personas.map((p) => (
            <div
              key={p.key}
              className={`card-chip p-7 flex flex-col ${
                p.featured ? 'ring-2 ring-brand-500/40 lg:-translate-y-2' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                <div
                  className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                    p.featured ? 'bg-brand-500 text-white' : 'bg-brand-50 text-brand-600'
                  }`}
                >
                  <p.icon className="h-5 w-5" />
                </div>
                {p.featured && (
                  <span className="text-xs font-semibold uppercase tracking-wider text-brand-700 bg-brand-50 px-2 py-1 rounded-full">
                    {t('homev2.jtbd.popular', 'Most popular')}
                  </span>
                )}
              </div>
              <h3 className="mt-5 font-display font-bold text-xl text-navy-900">
                {t(`homev2.jtbd.${p.key}_title`)}
              </h3>
              <p className="mt-2 text-sm text-navy-600">{t(`homev2.jtbd.${p.key}_subtitle`)}</p>
              <ul className="mt-5 space-y-2.5 mb-7 flex-1">
                {Array.from({ length: p.bullets }, (_, bi) => (
                  <li key={bi} className="flex items-start gap-2 text-sm text-navy-700">
                    <Check className="h-4 w-4 mt-0.5 text-brand-500 shrink-0" />
                    <span>{t(`homev2.jtbd.${p.key}_b${bi + 1}`)}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => navigate(getPath('/trainer/signup'))}
                className={`mt-auto ${p.featured ? 'pill-primary' : 'pill-ghost'} w-full justify-center`}
              >
                {t('homev2.jtbd.cta')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
