import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowRight, Check, Users, Briefcase } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { LocalizedLink } from '@/components/LocalizedLink';

export function PricingPreview() {
  const { t } = useTranslation('marketing');

  return (
    <section id="pricing" className="py-24 md:py-32">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <h2 className="text-3xl md:text-[42px] font-bold tracking-[-0.02em] text-center mb-14 text-foreground">
          {t('homev2.pricing.headline')}
        </h2>

        <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
          {/* Players card */}
          <Card className="h-full shadow-md border-0 rounded-xl">
            <CardHeader className="text-center p-8 pb-4">
              <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <CardTitle className="text-xl">{t('homev2.pricing.players_title')}</CardTitle>
              <p className="text-3xl font-bold mt-2">{t('homev2.pricing.players_price')}</p>
            </CardHeader>
            <CardContent className="text-center space-y-4 p-8 pt-4">
              <p className="text-muted-foreground">{t('homev2.pricing.players_desc')}</p>
              <p className="text-muted-foreground">{t('homev2.pricing.players_desc2')}</p>
              <Button size="lg" variant="outline" className="w-full rounded-lg" asChild>
                <Link to={getAppUrl('/signup/player')}>
                  {t('homev2.pricing.players_cta')}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          {/* Trainers card */}
          <Card className="h-full border-2 border-primary shadow-lg rounded-xl">
            <CardHeader className="text-center p-8 pb-4">
              <Briefcase className="h-8 w-8 text-primary mx-auto mb-2" />
              <CardTitle className="text-xl">{t('homev2.pricing.trainers_title')}</CardTitle>
              <p className="text-3xl font-bold mt-2">{t('homev2.pricing.trainers_price')}</p>
            </CardHeader>
            <CardContent className="text-center space-y-4 p-8 pt-4">
              <p className="text-muted-foreground">{t('homev2.pricing.trainers_desc')}</p>
              <Button size="lg" className="bg-primary hover:bg-primary/90 w-full rounded-lg shadow-md" asChild>
                <Link to={getAppUrl('/signup/trainer')}>
                  {t('homev2.cta.startTrial')}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <p className="text-sm text-muted-foreground">{t('homev2.pricing.no_cc')}</p>
              <p className="text-sm text-muted-foreground">{t('homev2.pricing.trainers_microcopy')}</p>
              <LocalizedLink to="/pricing" className="text-sm text-primary hover:underline">
                {t('homev2.pricing.seeAllPlans')}
              </LocalizedLink>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
