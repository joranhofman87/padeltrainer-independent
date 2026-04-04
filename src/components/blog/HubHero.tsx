import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, Clock, Share2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

interface HubHeroProps {
  title: string;
  excerpt?: string;
  category?: string;
  datePublished?: string;
  readTime: string;
  authorName?: string;
}

export function HubHero({ title, excerpt, category, datePublished, readTime, authorName }: HubHeroProps) {
  const { t, i18n } = useTranslation('marketing');
  const dateLocale = i18n.language === 'nl' ? 'nl-NL' : i18n.language === 'de' ? 'de-DE' : i18n.language === 'es' ? 'es-ES' : i18n.language === 'fr' ? 'fr-FR' : 'en-US';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-gradient-to-b from-muted/50 to-background py-16 md:py-20"
    >
      <div className="container mx-auto px-4 max-w-[900px]">
        <div className="flex items-center gap-3 mb-4">
          <Badge className="bg-accent text-accent-foreground text-xs font-semibold">
            Guide
          </Badge>
          {category && (
            <Badge variant="outline" className="text-xs">
              {category}
            </Badge>
          )}
        </div>

        <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold font-montserrat mb-4">
          {title}
        </h1>

        {excerpt && (
          <p className="text-lg text-muted-foreground max-w-2xl mb-6">
            {excerpt}
          </p>
        )}

        <div className="flex items-center gap-4 text-muted-foreground flex-wrap">
          {datePublished && (
            <span className="flex items-center gap-1 text-sm">
              <Calendar className="h-4 w-4" />
              {new Date(datePublished).toLocaleDateString(dateLocale, { month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          )}
          <span className="flex items-center gap-1 text-sm">
            <Clock className="h-4 w-4" />
            {readTime}
          </span>
          {authorName && <span className="text-sm">by {authorName}</span>}
          <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(window.location.href)}>
            <Share2 className="h-4 w-4 mr-2" />
            {t('blog.share')}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
