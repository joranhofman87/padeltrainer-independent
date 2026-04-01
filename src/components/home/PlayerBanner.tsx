import { motion } from 'framer-motion';
import { Dumbbell, MapPin, BookOpen, Video, PenLine, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';

const playerLinks = [
  { to: '/trainers', icon: Dumbbell, labelKey: 'footer.findTrainers' },
  { to: '/locations', icon: MapPin, labelKey: 'footer.locations' },
  { to: '/padel-rules', icon: BookOpen, labelKey: 'homev2.playerBanner.rules' },
  { to: '/video-tips', icon: Video, labelKey: 'homev2.playerBanner.videoTips' },
  { to: '/blog', icon: PenLine, labelKey: 'nav.blog' },
  { to: '/racket-finder', icon: Target, labelKey: 'quiz.title' },
];

export function PlayerBanner() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-12 md:py-16">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="rounded-2xl border border-primary/20 bg-primary/5 p-6 md:p-10"
        >
          <div className="mb-8">
            <h2 className="text-2xl md:text-3xl font-bold mb-1">
              {t('homev2.playerBanner.headline')}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t('homev2.playerBanner.subtitle')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 md:gap-3">
            {playerLinks.map((link) => (
              <LocalizedLink
                key={link.to}
                to={link.to}
                className="group flex items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-all hover:shadow-sm hover:border-primary/30"
              >
                <link.icon className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium text-foreground whitespace-nowrap">
                  {t(link.labelKey)}
                </span>
              </LocalizedLink>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
