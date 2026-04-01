import { Card, CardContent } from '@/components/ui/card';
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
    { key: 'hours' },
    { key: 'slots' },
    { key: 'noshows' },
  ];

  return (
    <section className="py-12 md:py-16">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <h2 className="text-center text-lg font-medium text-muted-foreground mb-10">
          {t('homev2.socialProof.headline')}
        </h2>

        {/* Testimonials */}
        <div className="grid md:grid-cols-2 gap-6 mb-14">
          {testimonials.map((item) => (
            <Card key={item.key} className="h-full shadow-md border-0 rounded-xl">
              <CardContent className="p-8">
                <div className="flex gap-0.5 mb-4">
                  {Array.from({ length: item.rating }).map((_, j) => (
                    <Star key={j} className="h-4 w-4 fill-primary text-primary" />
                  ))}
                </div>
                <p className="text-foreground mb-5 italic text-lg leading-relaxed">
                  "{t(`homev2.socialProof.testimonial${item.key}`)}"
                </p>
                <div className="flex items-center gap-3">
                  <Avatar className="h-14 w-14">
                    <AvatarImage
                      src={item.photo}
                      alt={t(`homev2.socialProof.author${item.key}`)}
                      loading="lazy"
                      decoding="async"
                    />
                    <AvatarFallback>
                      {t(`homev2.socialProof.author${item.key}`).charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {t(`homev2.socialProof.author${item.key}`)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(`homev2.socialProof.author${item.key}role`)}
                    </p>
                  </div>
                  <img
                    src={item.logo}
                    alt=""
                    className="h-7 object-contain opacity-60"
                    loading="lazy"
                    decoding="async"
                    width={80}
                    height={28}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Metrics — big bold numbers */}
        <div className="flex flex-wrap justify-center gap-12 md:gap-20 text-center mb-4">
          {metrics.map(m => (
            <div
              key={m.key}
              className="flex flex-col items-center gap-1"
            >
              <span className="text-4xl md:text-5xl font-extrabold text-[hsl(var(--brand-navy))]">
                {t(`homev2.socialProof.metric_${m.key}_value`)}
              </span>
              <span className="text-sm text-muted-foreground">
                {t(`homev2.socialProof.metric_${m.key}_label`)}
              </span>
            </div>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          {t('homev2.socialProof.disclaimer')}
        </p>
      </div>
    </section>
  );
}
