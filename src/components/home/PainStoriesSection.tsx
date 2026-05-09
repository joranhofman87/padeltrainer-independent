import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, MessageSquare, CalendarX, Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

const painItems = [
  { key: 'whatsapp', icon: MessageSquare },
  { key: 'cancellation', icon: CalendarX },
  { key: 'payments', icon: Receipt },
];

export function PainStoriesSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="py-16 md:py-20">
      <div className="max-w-[1200px] mx-auto px-4 md:px-6">
        <h2 className="font-display text-3xl md:text-[44px] font-extrabold tracking-[-0.02em] mb-12 text-foreground">
          {t('homev2.pain.headline')}
        </h2>

        <div className="space-y-6 mb-12">
          {painItems.map((item) => (
            <div
              key={item.key}
              className="bg-card rounded-lg border-l-4 border-l-primary shadow-sm p-8"
            >
              <div className="flex items-start gap-4">
                <item.icon className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="space-y-0">
                  <p className="text-[17px] text-foreground leading-relaxed">
                    {t(`homev2.pain.${item.key}_story`)}
                  </p>
                  <p className="text-primary font-medium mt-4">
                    {t(`homev2.pain.${item.key}_solution`)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <Button size="lg" className="bg-primary hover:bg-primary/90 rounded-lg px-8 py-4 h-14 shadow-md" asChild>
          <Link to={getAppUrl('/signup/trainer')}>
            {t('homev2.cta.startTrial')}
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
