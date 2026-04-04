import { LocalizedLink } from '@/components/LocalizedLink';
import { Badge } from '@/components/ui/badge';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface GuideCardProps {
  title: string;
  slug: string;
  excerpt?: string;
  category?: string;
}

export function GuideCard({ title, slug, excerpt, category }: GuideCardProps) {
  const { t } = useTranslation('marketing');

  return (
    <LocalizedLink
      to={`/blog/${slug}`}
      className="group block rounded-xl border border-border bg-card p-6 shadow-sm transition-all duration-200 hover:shadow-md hover:border-l-4 hover:border-l-accent"
    >
      {category && (
        <Badge variant="secondary" className="mb-3 text-xs font-semibold">
          {category}
        </Badge>
      )}

      <h3 className="font-montserrat font-bold text-lg text-foreground mb-2 line-clamp-2 group-hover:text-primary transition-colors">
        {title}
      </h3>

      {excerpt && (
        <p className="text-sm text-muted-foreground line-clamp-3 mb-4">
          {excerpt}
        </p>
      )}

      <span className="inline-flex items-center text-sm font-semibold text-accent group-hover:underline">
        {t('blog.readGuide', 'Read guide')}
        <ArrowRight className="h-4 w-4 ml-1 transition-transform group-hover:translate-x-1" />
      </span>
    </LocalizedLink>
  );
}
