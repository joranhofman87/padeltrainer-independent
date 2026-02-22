import { Card, CardContent } from '@/components/ui/card';
import { motion } from 'framer-motion';
import { Star, Quote } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function SocialProofStrip() {
  const { t } = useTranslation('marketing');

  const testimonials = [
    { key: '1', rating: 5 },
    { key: '2', rating: 5 },
  ];

  const metrics = [
    { key: 'hours', emoji: '⏱️' },
    { key: 'slots', emoji: '📅' },
    { key: 'noshows', emoji: '📉' },
  ];

  return (
    <section className="border-y bg-muted/30">
      <div className="container mx-auto px-4 py-14">
        <motion.h2
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="text-center text-lg font-medium text-muted-foreground mb-8"
        >
          {t('homev2.socialProof.headline')}
        </motion.h2>

        {/* Logo placeholders */}
        <div className="flex flex-wrap items-center justify-center gap-8 mb-12 opacity-40">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 w-24 rounded bg-muted-foreground/20" />
          ))}
        </div>

        {/* Testimonials */}
        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto mb-10">
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
                  <Quote className="h-5 w-5 text-primary/40 mb-3" />
                  <div className="flex gap-0.5 mb-3">
                    {Array.from({ length: item.rating }).map((_, j) => (
                      <Star key={j} className="h-3.5 w-3.5 fill-primary text-primary" />
                    ))}
                  </div>
                  <p className="text-foreground mb-3 italic">"{t(`homev2.socialProof.testimonial${item.key}`)}"</p>
                  <p className="text-sm text-muted-foreground">— {t(`homev2.socialProof.author${item.key}`)}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* Metric placeholders */}
        <div className="flex flex-wrap justify-center gap-8 text-center">
          {metrics.map(m => (
            <div key={m.key} className="flex flex-col items-center">
              <span className="text-2xl font-bold text-foreground">{t(`homev2.socialProof.metric_${m.key}_value`)}</span>
              <span className="text-sm text-muted-foreground">{t(`homev2.socialProof.metric_${m.key}_label`)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
