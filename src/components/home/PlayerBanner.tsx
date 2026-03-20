import { motion } from 'framer-motion';
import { Dumbbell, MapPin, BookOpen, Video, PenLine, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LocalizedLink } from '@/components/LocalizedLink';

const playerLinks = [
  { to: '/trainers', icon: Dumbbell, labelKey: 'footer.findTrainers', descKey: 'homev2.playerBanner.trainersDesc' },
  { to: '/locations', icon: MapPin, labelKey: 'footer.locations', descKey: 'homev2.playerBanner.locationsDesc' },
  { to: '/padel-rules', icon: BookOpen, labelKey: 'homev2.playerBanner.rules', descKey: 'homev2.playerBanner.rulesDesc' },
  { to: '/video-tips', icon: Video, labelKey: 'homev2.playerBanner.videoTips', descKey: 'homev2.playerBanner.videoTipsDesc' },
  { to: '/blog', icon: PenLine, labelKey: 'nav.blog', descKey: 'homev2.playerBanner.blogDesc' },
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

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 md:gap-4">
            {playerLinks.map((link) => (
              <LocalizedLink
                key={link.to}
                to={link.to}
                className="group flex flex-col items-start gap-2 rounded-xl border bg-card p-4 md:p-5 transition-all hover:shadow-md hover:border-primary/30 h-full"
              >
                <link.icon className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <span className="block text-sm font-medium text-foreground">
                    {t(link.labelKey)}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground leading-snug">
                    {t(link.descKey)}
                  </span>
                </div>
              </LocalizedLink>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
