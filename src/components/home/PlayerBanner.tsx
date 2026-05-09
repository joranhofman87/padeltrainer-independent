import { Dumbbell, MapPin, BookOpen, Video, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';

const playerLinks = [
  { to: '/trainers', icon: Dumbbell, labelKey: 'footer.findTrainers' },
  { to: '/locations', icon: MapPin, labelKey: 'footer.locations' },
  { to: '/padel-rules', icon: BookOpen, labelKey: 'homev2.playerBanner.rules' },
  { to: '/video-tips', icon: Video, labelKey: 'homev2.playerBanner.videoTips' },
  { to: '/blog', icon: PenLine, labelKey: 'nav.blog' },
];

export function PlayerBanner() {
  const { t } = useTranslation('marketing');

  return (
    <section id="players" className="py-24 md:py-32 bg-offwhite">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="card-chip p-8 md:p-12 flex flex-col md:flex-row md:items-center md:justify-between gap-8">
          <div className="md:max-w-md">
            <span className="eyebrow">{t('homev2.playerBanner.eyebrow', 'For players')}</span>
            <h2 className="mt-4 font-display text-3xl md:text-4xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
              {t('homev2.playerBanner.headline')}
            </h2>
            <p className="mt-4 text-navy-700 leading-relaxed">
              {t('homev2.playerBanner.subtitle')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 md:max-w-md">
            {playerLinks.map((link) => (
              <LocalizedLink
                key={link.to}
                to={link.to}
                className="inline-flex items-center gap-2 rounded-full bg-card border border-navy-900/10 shadow-soft px-4 py-2.5 text-sm font-medium text-navy-900 transition hover:-translate-y-px hover:border-navy-900/20"
              >
                <link.icon className="h-4 w-4 text-brand-600 shrink-0" />
                {t(link.labelKey)}
              </LocalizedLink>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
