import { Button } from '@/components/ui/button';
import { LocalizedLink } from '@/components/LocalizedLink';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CtaFields } from '@/lib/sanity';

interface CTASectionProps {
  cta: CtaFields | null;
  fallbackLabel?: string;
  fallbackUrl?: string;
  fallbackDescription?: string;
}

export function CTASection({ cta, fallbackLabel, fallbackUrl = '/trainers', fallbackDescription }: CTASectionProps) {
  const { t } = useTranslation('marketing');
  const label = cta?.label || fallbackLabel || t('blog.findTrainers', 'Find Trainers');
  const url = cta?.url || fallbackUrl;
  const description = fallbackDescription || t('rules.ctaDescription', 'Find a certified padel trainer near you.');

  return (
    <div className="mt-12 p-8 bg-accent/30 rounded-xl text-center">
      <h3 className="text-xl font-bold mb-2">{label}</h3>
      <p className="text-muted-foreground mb-4">{description}</p>
      <Button asChild>
        <LocalizedLink to={url} className="flex items-center gap-2">
          {label} <ArrowRight className="h-4 w-4" />
        </LocalizedLink>
      </Button>
    </div>
  );
}
