import { GuideCard } from './GuideCard';
import { useTranslation } from 'react-i18next';
import type { SpokeArticle } from '@/lib/hubPages';

interface RelatedGuidesSectionProps {
  articles: SpokeArticle[];
}

export function RelatedGuidesSection({ articles }: RelatedGuidesSectionProps) {
  const { t } = useTranslation('marketing');

  if (articles.length === 0) return null;

  return (
    <section className="mt-12 mb-8">
      <h2 className="font-montserrat text-2xl md:text-3xl font-bold mb-6">
        {t('blog.relatedGuides', 'Related Guides')}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {articles.map((article) => (
          <GuideCard
            key={article.slug}
            title={article.title}
            slug={article.slug}
            excerpt={article.excerpt}
            category={article.category}
          />
        ))}
      </div>
    </section>
  );
}
