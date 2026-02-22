import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { ArrowRight, Check, Users, Briefcase } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { LocalizedLink } from '@/components/LocalizedLink';

export function PricingPreview() {
  const { t } = useTranslation('marketing');

  return (
    <section id="pricing" className="py-20 md:py-28 bg-muted/30">
      <div className="container mx-auto px-4">
        <motion.h2
          className="text-3xl md:text-4xl font-bold text-center mb-12"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          {t('homev2.pricing.headline')}
        </motion.h2>

        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
          {/* Players card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <Card className="h-full">
              <CardHeader className="text-center">
                <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <CardTitle className="text-xl">{t('homev2.pricing.players_title')}</CardTitle>
                <p className="text-3xl font-bold mt-2">{t('homev2.pricing.players_price')}</p>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-center">{t('homev2.pricing.players_desc')}</p>
              </CardContent>
            </Card>
          </motion.div>

          {/* Trainers card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
          >
            <Card className="h-full border-primary/50 border-2">
              <CardHeader className="text-center">
                <Briefcase className="h-8 w-8 text-primary mx-auto mb-2" />
                <CardTitle className="text-xl">{t('homev2.pricing.trainers_title')}</CardTitle>
                <p className="text-3xl font-bold mt-2">{t('homev2.pricing.trainers_price')}</p>
              </CardHeader>
              <CardContent className="text-center space-y-4">
                <p className="text-muted-foreground">{t('homev2.pricing.trainers_desc')}</p>
                <Button size="lg" className="bg-primary hover:bg-primary/90 w-full" asChild>
                  <Link to={getAppUrl('/signup/trainer')}>
                    {t('homev2.cta.startTrial')}
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Link>
                </Button>
                <p className="text-sm text-muted-foreground">{t('homev2.pricing.trainers_microcopy')}</p>
                <LocalizedLink to="/pricing" className="text-sm text-primary hover:underline">
                  {t('homev2.pricing.seeAllPlans')}
                </LocalizedLink>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
