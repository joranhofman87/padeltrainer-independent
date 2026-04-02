import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { ArrowRight, Zap, LayoutGrid, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, STROKES_LIST_QUERY } from '@/lib/sanity';
import { MARKETING_DOMAIN } from '@/lib/domains';
import type { SeoFields } from '@/lib/sanity';

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
    try { return localStorage.getItem('strokes-group-by-category') !== 'false'; } catch { return true; }
  });

  const { data: strokes = [], isLoading } = useQuery({
    queryKey: ['strokes-list', lang],
    queryFn: () => sanityClient.fetch<StrokeListItem[]>(STROKES_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const filtered = useMemo(() => {
    if (levelFilter === 'all') return strokes;
    return strokes.filter(s => s.difficulty?.toLowerCase() === levelFilter.toLowerCase());
  }, [strokes, levelFilter]);

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, StrokeListItem[]>>((acc, s) => {
      const cat = s.category || 'Other';
      (acc[cat] = acc[cat] || []).push(s);
      return acc;
    }, {});
  }, [filtered]);

  const starterStrokes = useMemo(() => {
    return strokes.filter(s => STARTER_STROKES.some(ss => s.slug?.toLowerCase().includes(ss) || s.title?.toLowerCase().includes(ss)));
  }, [strokes]);

  const showStarterSection = levelFilter === 'all' && starterStrokes.length > 0;

  const breadcrumbListSD = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": t('nav.home', 'Home'), "item": `${MARKETING_DOMAIN}/${lang}` },
      { "@type": "ListItem", "position": 2, "name": t('strokes.breadcrumbLearn', 'Learn'), "item": `${MARKETING_DOMAIN}/${lang}/learn` },
      { "@type": "ListItem", "position": 3, "name": t('strokes.title', 'Padel Strokes & Techniques') },
    ],
  };

  const itemListSD = strokes.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('strokes.title', 'Padel Strokes & Techniques'),
    "itemListElement": strokes.map((s, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": s.h1 || s.title,
      "url": `${MARKETING_DOMAIN}/${lang}/padel-strokes/${s.slug}`,
    })),
  } : undefined;

  const difficultyColor = (d: string | null) => {
    if (!d) return 'secondary';
    if (d.toLowerCase().includes('beginner')) return 'default';
    if (d.toLowerCase().includes('advanced')) return 'destructive';
    return 'secondary';
  };

  const handleLevelChange = (level: string) => {
    if (level === 'all') {
      searchParams.delete('level');
    } else {
      searchParams.set('level', level);
    }
    setSearchParams(searchParams, { replace: true });
  };

  const toggleGrouping = () => {
    const next = !groupByCategory;
    setGroupByCategory(next);
    try { localStorage.setItem('strokes-group-by-category', String(next)); } catch {}
  };

  const renderStrokeCard = (stroke: StrokeListItem, index: number) => (
    <motion.div
      key={stroke._id}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.05 }}
    >
      <LocalizedLink to={`/padel-strokes/${stroke.slug}`}>
        <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
          <CardContent className="p-6">
            <div className="flex gap-2 mb-3">
              {stroke.category && <Badge variant="secondary">{stroke.category}</Badge>}
              {stroke.difficulty && (
                <Badge variant={difficultyColor(stroke.difficulty) as any}>
                  {stroke.difficulty}
                </Badge>
              )}
            </div>
            <CardTitle className="text-lg mb-2 hover:text-primary transition-colors">
              {stroke.h1 || stroke.title}
            </CardTitle>
            <CardDescription className="line-clamp-2 mb-4">
              {stroke.shortDescription || t('strokes.defaultDescription', 'Learn this essential padel stroke and improve your game.')}
            </CardDescription>
            <span className="text-sm text-primary font-medium flex items-center gap-1">
              {t('strokes.learnMore', 'Learn more')} <ArrowRight className="h-3 w-3" />
            </span>
          </CardContent>
        </Card>
      </LocalizedLink>
    </motion.div>
  );

  return (
    <MarketingLayout>
      <SEO
        title={t('strokes.title', 'Padel Strokes & Techniques')}
        description={t('strokes.metaDescription', 'Master every padel stroke – from the bandeja to the vibora. Video tutorials, tips, and technique breakdowns.')}
        url="/padel-strokes"
        structuredData={[breadcrumbListSD, ...(itemListSD ? [itemListSD] : [])]}
      />

      {/* Hero */}
      <section className="py-16 bg-background">
        <div className="container mx-auto px-4">
          <Breadcrumbs items={[
            { label: t('strokes.breadcrumbLearn', 'Learn'), href: '/learn' },
            { label: t('strokes.title', 'Padel Strokes & Techniques') },
          ]} />
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('strokes.title', 'Padel Strokes & Techniques')}</h1>
            <p className="text-xl text-muted-foreground mb-6">
              {t('strokes.subtitle', 'Learn every shot in padel with expert tips, video tutorials, and detailed technique breakdowns.')}
            </p>
            <p className="text-base text-muted-foreground max-w-2xl mx-auto">
              {t('strokes.introText', 'Master the fundamental strokes that form the foundation of competitive padel play. Each stroke serves a specific purpose on the court, from defensive shots to aggressive winners. Whether you\'re starting out or refining your technique, this guide breaks down the essential movements every player should master.')}
            </p>
          </motion.div>
        </div>
      </section>

      {/* Start Here Section */}
      {showStarterSection && (
        <section className="py-8 border-b">
          <div className="container mx-auto px-4">
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-6">
              <h2 className="text-xl font-bold mb-1 flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                {t('strokes.startHere', 'Start Here')}
              </h2>
              <p className="text-sm text-muted-foreground mb-4">{t('strokes.startHereDescription', 'New to padel? Begin with these essential strokes.')}</p>
              <div className="flex flex-wrap gap-2">
                {starterStrokes.slice(0, 5).map(s => (
                  <LocalizedLink key={s._id} to={`/padel-strokes/${s.slug}`}>
                    <Badge variant="outline" className="px-3 py-1.5 text-sm cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors">
                      {s.h1 || s.title}
                    </Badge>
                  </LocalizedLink>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Filters */}
      {!isLoading && strokes.length > 0 && (
        <section className="py-4 border-b">
          <div className="container mx-auto px-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge
                variant={levelFilter === 'all' ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => handleLevelChange('all')}
              >
                {t('strokes.filterAll', 'All')}
              </Badge>
              {DIFFICULTY_LEVELS.map(level => (
                <Badge
                  key={level}
                  variant={levelFilter.toLowerCase() === level.toLowerCase() ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => handleLevelChange(level)}
                >
                  {t(`strokes.filter${level}`, level)}
                </Badge>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={toggleGrouping} className="text-muted-foreground text-xs">
              {groupByCategory ? <List className="h-3.5 w-3.5 mr-1" /> : <LayoutGrid className="h-3.5 w-3.5 mr-1" />}
              {groupByCategory ? t('strokes.viewFlat', 'Flat view') : t('strokes.viewGrouped', 'Group by category')}
            </Button>
          </div>
        </section>
      )}

      {/* Content */}
      <section className="py-12">
        <div className="container mx-auto px-4">
          {isLoading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <Card key={i} className="h-full">
                  <CardContent className="p-6">
                    <Skeleton className="h-5 w-20 mb-3" />
                    <Skeleton className="h-6 w-full mb-2" />
                    <Skeleton className="h-4 w-full mb-4" />
                    <Skeleton className="h-4 w-3/4" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
                <Zap className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-semibold mb-2">{t('strokes.noResults', 'No strokes found')}</h2>
              <p className="text-muted-foreground">{t('strokes.noResultsDescription', 'Try a different filter or check back soon.')}</p>
            </div>
          ) : groupByCategory ? (
            <div className="space-y-12">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <h2 className="text-2xl font-bold mb-6 capitalize">{category}</h2>
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
        </div>
      </section>
    </MarketingLayout>
  );
}
