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
    <section className="py-16 md:py-20 bg-[#F5F5F3]">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          {/* Left: text */}
          <div className="md:max-w-md">
            <h2 className="text-2xl md:text-3xl font-bold mb-2 text-[hsl(var(--brand-navy))]">
              {t('homev2.playerBanner.headline')}
            </h2>
            <p className="text-muted-foreground">
              {t('homev2.playerBanner.subtitle')}
            </p>
          </div>

          {/* Right: pill links */}
          <div className="flex flex-wrap gap-2">
            {playerLinks.map((link) => (
              <LocalizedLink
                key={link.to}
                to={link.to}
                className="inline-flex items-center gap-2 rounded-full bg-card border px-4 py-2 text-sm font-medium text-foreground transition-all hover:shadow-sm hover:border-primary/30"
              >
                <link.icon className="h-4 w-4 text-primary shrink-0" />
                {t(link.labelKey)}
              </LocalizedLink>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
