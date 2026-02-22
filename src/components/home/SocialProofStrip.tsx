import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { Star, Clock, CalendarPlus, TrendingDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

import bramosLogo from '@/assets/testimonials/bramos-padel.png';
import rlPadelLogo from '@/assets/testimonials/rl-padel-performance.avif';
import bramPhoto from '@/assets/testimonials/bram-meijer.png';
import renePhoto from '@/assets/testimonials/rene-lindenbergh.png';

export function SocialProofStrip() {
  const { t } = useTranslation('marketing');

  const testimonials = [
    {
      key: '1',
      rating: 5,
      photo: bramPhoto,
      logo: bramosLogo,
    },
    {
      key: '2',
      rating: 5,
      photo: renePhoto,
      logo: rlPadelLogo,
    },
  ];

  const metrics = [
    { key: 'hours', icon: Clock },
    { key: 'slots', icon: CalendarPlus },
    { key: 'noshows', icon: TrendingDown },
  ];

  return (
    <section className="border-y bg-muted/30">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-14">
        <motion.h2
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="text-center text-lg font-medium text-muted-foreground mb-8"
        >
          {t('homev2.socialProof.headline')}
        </motion.h2>

        {/* Testimonials */}
        <div className="grid md:grid-cols-2 gap-6 mb-12">
          {testimonials.map((item, i) => (
            <motion.div
              key={item.key}
              initial={{ opacity: 0, y: 15 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1 }}
            >
              <Card className="h-full">
                <CardContent className="p-6">
                  <div className="flex gap-0.5 mb-3">
                    {Array.from({ length: item.rating }).map((_, j) => (
                      <Star key={j} className="h-3.5 w-3.5 fill-primary text-primary" />
                    ))}
                  </div>
                  <p className="text-foreground mb-4 italic">
                    "{t(`homev2.socialProof.testimonial${item.key}`)}"
                  </p>
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={item.photo} alt={t(`homev2.socialProof.author${item.key}`)} />
                      <AvatarFallback>
                        {t(`homev2.socialProof.author${item.key}`).charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {t(`homev2.socialProof.author${item.key}`)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(`homev2.socialProof.author${item.key}role`)}
                      </p>
                    </div>
                    <img src={item.logo} alt="" className="h-6 object-contain opacity-60" />
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Metrics */}
        <div className="flex flex-wrap justify-center gap-8 md:gap-14 text-center mb-4">
          {metrics.map(m => {
            const Icon = m.icon;
            return (
              <motion.div
                key={m.key}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="flex flex-col items-center gap-1"
              >
                <Icon className="h-5 w-5 text-primary mb-1" />
                <span className="text-2xl font-bold text-foreground">
                  {t(`homev2.socialProof.metric_${m.key}_value`)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`homev2.socialProof.metric_${m.key}_label`)}
                </span>
              </motion.div>
            );
          })}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          {t('homev2.socialProof.disclaimer')}
        </p>
      </div>
    </section>
  );
}
