import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { ArrowRight, Zap, LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, STROKES_LIST_QUERY } from '@/lib/sanity';
import { MARKETING_DOMAIN } from '@/lib/domains';
import type { SeoFields } from '@/lib/sanity';
import { MarketingHero, MarketingSection } from '@/components/marketing/sections';
import { cn } from '@/lib/utils';

interface StrokeListItem {
  _id: string;
  title: string;
  slug: string;
  h1: string;
  shortDescription: string;
  category: string | null;
  difficulty: string | null;
  seo: SeoFields | null;
}

const DIFFICULTY_LEVELS = ['Beginner', 'Intermediate', 'Advanced'] as const;
const STARTER_STROKES = ['forehand', 'backhand', 'serve', 'return', 'volley'];

export default function Strokes() {
  const { t, i18n } = useTranslation('marketing');
  const lang = i18n.language || 'en';
  const [searchParams, setSearchParams] = useSearchParams();
  const levelFilter = searchParams.get('level') || 'all';
  const [groupByCategory, setGroupByCategory] = useState(() => {
    try {
      return localStorage.getItem('strokes-group-by-category') !== 'false';
    } catch {
      return true;
    }
  });

  const { data: strokes = [], isLoading } = useQuery({
    queryKey: ['strokes-list', lang],
    queryFn: () => sanityClient.fetch<StrokeListItem[]>(STROKES_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const filtered = useMemo(() => {
    if (levelFilter === 'all') return strokes;
    return strokes.filter((s) => s.difficulty?.toLowerCase() === levelFilter.toLowerCase());
  }, [strokes, levelFilter]);

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, StrokeListItem[]>>((acc, s) => {
      const cat = s.category || 'Other';
      (acc[cat] = acc[cat] || []).push(s);
      return acc;
    }, {});
  }, [filtered]);

  const starterStrokes = useMemo(() => {
    return strokes.filter((s) =>
      STARTER_STROKES.some(
        (ss) => s.slug?.toLowerCase().includes(ss) || s.title?.toLowerCase().includes(ss),
      ),
    );
  }, [strokes]);

  const showStarterSection = levelFilter === 'all' && starterStrokes.length > 0;

  const breadcrumbListSD = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('nav.home', 'Home'), item: `${MARKETING_DOMAIN}/${lang}` },
      { '@type': 'ListItem', position: 2, name: t('strokes.breadcrumbLearn', 'Learn'), item: `${MARKETING_DOMAIN}/${lang}/learn` },
      { '@type': 'ListItem', position: 3, name: t('strokes.title', 'Padel Strokes & Techniques') },
    ],
  };

  const itemListSD =
    strokes.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: t('strokes.title', 'Padel Strokes & Techniques'),
          itemListElement: strokes.map((s, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: s.h1 || s.title,
            url: `${MARKETING_DOMAIN}/${lang}/padel-strokes/${s.slug}`,
          })),
        }
      : undefined;

  const handleLevelChange = (level: string) => {
    if (level === 'all') searchParams.delete('level');
    else searchParams.set('level', level);
    setSearchParams(searchParams, { replace: true });
  };

  const toggleGrouping = () => {
    const next = !groupByCategory;
    setGroupByCategory(next);
    try {
      localStorage.setItem('strokes-group-by-category', String(next));
    } catch {
      /* non-fatal: persisting the grouping preference is best-effort */
    }
  };

  const renderStrokeCard = (stroke: StrokeListItem, index: number) => (
    <motion.div
      key={stroke._id}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.04 }}
    >
      <LocalizedLink to={`/padel-strokes/${stroke.slug}`} className="block group h-full">
        <div className="card-chip p-6 h-full flex flex-col transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {stroke.category && (
              <span className="text-xs rounded-full bg-brand-50 text-brand-700 px-2 py-0.5 font-semibold uppercase tracking-wide">
                {stroke.category}
              </span>
            )}
            {stroke.difficulty && (
              <span className="text-xs rounded-full border border-navy-100 text-navy-700 px-2 py-0.5 font-medium">
                {stroke.difficulty}
              </span>
            )}
          </div>
          <h3 className="font-display text-lg font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors">
            {stroke.h1 || stroke.title}
          </h3>
          <p className="text-navy-600 text-sm line-clamp-2 mb-4 flex-1">
            {stroke.shortDescription ||
              t('strokes.defaultDescription', 'Learn this essential padel stroke and improve your game.')}
          </p>
          <span className="text-sm text-brand-600 font-semibold flex items-center gap-1">
            {t('strokes.learnMore', 'Learn more')} <ArrowRight className="h-3 w-3" />
          </span>
        </div>
      </LocalizedLink>
    </motion.div>
  );

  return (
    <MarketingLayout>
      <SEO
        title={t('strokes.title', 'Padel Strokes & Techniques')}
        description={t('strokes.metaDescription', 'Master every padel stroke - from the bandeja to the vibora. Video tutorials, tips, and technique breakdowns.')}
        url="/padel-strokes"
        structuredData={[breadcrumbListSD, ...(itemListSD ? [itemListSD] : [])]}
      />

      <MarketingHero
        eyebrow={t('strokes.eyebrow', 'Technique library')}
        title={t('strokes.title', 'Padel Strokes & Techniques')}
        subtitle={t('strokes.subtitle', 'Learn every shot in padel with expert tips, video tutorials, and detailed technique breakdowns.')}
        compact
      />

      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <Breadcrumbs
          items={[
            { label: t('strokes.breadcrumbLearn', 'Learn'), href: '/learn' },
            { label: t('strokes.title', 'Padel Strokes & Techniques') },
          ]}
        />
      </div>

      {showStarterSection && (
        <section className="py-6">
          <div className="max-w-7xl mx-auto px-4 md:px-6">
            <div className="card-chip p-6 ring-1 ring-brand-100">
              <h2 className="font-display text-xl font-bold text-navy-900 mb-1 flex items-center gap-2">
                <Zap className="h-5 w-5 text-brand-500" />
                {t('strokes.startHere', 'Start Here')}
              </h2>
              <p className="text-sm text-navy-600 mb-4">
                {t('strokes.startHereDescription', 'New to padel? Begin with these essential strokes.')}
              </p>
              <div className="flex flex-wrap gap-2">
                {starterStrokes.slice(0, 5).map((s) => (
                  <LocalizedLink
                    key={s._id}
                    to={`/padel-strokes/${s.slug}`}
                    className="rounded-full border border-navy-100 bg-card px-3 py-1.5 text-sm font-medium text-navy-700 hover:bg-brand-500 hover:text-white hover:border-brand-500 transition-colors"
                  >
                    {s.h1 || s.title}
                  </LocalizedLink>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {!isLoading && strokes.length > 0 && (
        <section className="border-y border-navy-100">
          <div className="max-w-7xl mx-auto px-4 md:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleLevelChange('all')}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                  levelFilter === 'all'
                    ? 'bg-navy-900 text-white'
                    : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
                )}
              >
                {t('strokes.filterAll', 'All')}
              </button>
              {DIFFICULTY_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => handleLevelChange(level)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
                    levelFilter.toLowerCase() === level.toLowerCase()
                      ? 'bg-navy-900 text-white'
                      : 'bg-card border border-navy-100 text-navy-700 hover:text-brand-600',
                  )}
                >
                  {t(`strokes.filter${level}`, level)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={toggleGrouping}
              className="text-xs text-navy-600 hover:text-brand-600 inline-flex items-center"
            >
              {groupByCategory ? <List className="h-3.5 w-3.5 mr-1" /> : <LayoutGrid className="h-3.5 w-3.5 mr-1" />}
              {groupByCategory ? t('strokes.viewFlat', 'Flat view') : t('strokes.viewGrouped', 'Group by category')}
            </button>
          </div>
        </section>
      )}

      <MarketingSection background="default">
        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card-chip p-6">
                <Skeleton className="h-5 w-20 mb-3" />
                <Skeleton className="h-6 w-full mb-2" />
                <Skeleton className="h-4 w-full mb-4" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-navy-50 mb-4">
              <Zap className="h-8 w-8 text-navy-500" />
            </div>
            <h2 className="font-display text-xl font-bold text-navy-900 mb-2">{t('strokes.noResults', 'No strokes found')}</h2>
            <p className="text-navy-600">{t('strokes.noResultsDescription', 'Try a different filter or check back soon.')}</p>
          </div>
        ) : groupByCategory ? (
          <div className="space-y-12">
            {Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <h2 className="font-display text-2xl md:text-3xl font-extrabold tracking-[-0.02em] text-navy-900 mb-6 capitalize">
                  {category}
                </h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {items.map((stroke, index) => renderStrokeCard(stroke, index))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((stroke, index) => renderStrokeCard(stroke, index))}
          </div>
        )}
      </MarketingSection>
    </MarketingLayout>
  );
}
