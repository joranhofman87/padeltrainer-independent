import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { ArrowRight, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, STROKES_LIST_QUERY } from '@/lib/sanity';
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

export default function Strokes() {
  const { t } = useTranslation('marketing');

  const { data: strokes = [], isLoading } = useQuery({
    queryKey: ['strokes-list'],
    queryFn: () => sanityClient.fetch<StrokeListItem[]>(STROKES_LIST_QUERY),
    staleTime: 1000 * 60 * 10,
  });

  const itemListStructuredData = strokes.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Padel Strokes & Techniques",
    "itemListElement": strokes.map((s, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": s.h1 || s.title,
      "url": `https://padeltrainer.ai/padel-strokes/${s.slug}`,
    })),
  } : undefined;

  // Group by category
  const grouped = strokes.reduce<Record<string, StrokeListItem[]>>((acc, s) => {
    const cat = s.category || 'Other';
    (acc[cat] = acc[cat] || []).push(s);
    return acc;
  }, {});

  const difficultyColor = (d: string | null) => {
    if (!d) return 'secondary';
    if (d.toLowerCase().includes('beginner')) return 'default';
    if (d.toLowerCase().includes('advanced')) return 'destructive';
    return 'secondary';
  };

  return (
    <MarketingLayout>
      <SEO
        title="Padel Strokes & Techniques"
        description="Master every padel stroke – from the bandeja to the vibora. Video tutorials, tips, and technique breakdowns."
        url="/padel-strokes"
        structuredData={itemListStructuredData}
      />

      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Padel Strokes & Techniques</h1>
            <p className="text-xl text-muted-foreground">
              Learn every shot in padel with expert tips, video tutorials, and detailed technique breakdowns.
            </p>
          </motion.div>
        </div>
      </section>

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
          ) : strokes.length === 0 ? (
            <div className="text-center py-16">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
                <Zap className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-semibold mb-2">No strokes yet</h2>
              <p className="text-muted-foreground">Check back soon for technique content.</p>
            </div>
          ) : (
            <div className="space-y-12">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category}>
                  <h2 className="text-2xl font-bold mb-6 capitalize">{category}</h2>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {items.map((stroke, index) => (
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
                                {stroke.shortDescription}
                              </CardDescription>
                              <span className="text-sm text-primary font-medium flex items-center gap-1">
                                Learn more <ArrowRight className="h-3 w-3" />
                              </span>
                            </CardContent>
                          </Card>
                        </LocalizedLink>
                      </motion.div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </MarketingLayout>
  );
}
