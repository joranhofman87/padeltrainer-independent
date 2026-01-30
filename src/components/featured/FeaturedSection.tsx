import React from 'react';
import { Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';

interface FeaturedSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function FeaturedSection({ title, description, children, className = '' }: FeaturedSectionProps) {
  return (
    <section className={`py-6 px-4 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 rounded-xl border border-primary/10 ${className}`}>
      <div className="flex items-center gap-2 mb-4">
        <Star className="h-5 w-5 text-primary fill-primary/50" />
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {description && (
        <p className="text-sm text-muted-foreground mb-4">{description}</p>
      )}
      <div className="overflow-x-auto pb-2 -mx-4 px-4">
        <div className="flex gap-4 min-w-max lg:grid lg:grid-cols-4 lg:min-w-0">
          {children}
        </div>
      </div>
    </section>
  );
}

export function FeaturedBadge() {
  const { t } = useTranslation('common');
  return (
    <Badge className="bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0 text-xs">
      <Star className="h-3 w-3 mr-1 fill-current" />
      {t('featured.badge')}
    </Badge>
  );
}

// Shuffle array helper for fair rotation of featured items
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}
