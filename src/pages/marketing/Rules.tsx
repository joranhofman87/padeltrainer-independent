import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { BookOpen, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { sanityClient, RULES_LIST_QUERY } from '@/lib/sanity';

interface RulesArticle {
  _id: string;
  title: string;
  slug: string;
  h1: string;
  intro: string;
  quickAnswer: string;
  pageType: 'hub' | 'child';
  seo: { titleTag: string; metaDescription: string; breadcrumbLabel?: string } | null;
  datePublished: string | null;
  dateModified: string | null;
}

export default function Rules() {
  const { t } = useTranslation('marketing');

  const { data: articles = [], isLoading } = useQuery({
    queryKey: ['rules-articles'],
    queryFn: () => sanityClient.fetch<RulesArticle[]>(RULES_LIST_QUERY),
    staleTime: 1000 * 60 * 10,
  });

  const itemListStructuredData = articles.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Padel Rules & Regulations",
    "itemListElement": articles.map((a, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": a.h1,
      "url": `https://padeltrainer.ai/padel-rules/${a.slug}`,
    })),
  } : undefined;

  const hubPages = articles.filter(a => a.pageType === 'hub');
  const childPages = articles.filter(a => a.pageType === 'child');

  return (
    <MarketingLayout>
      <SEO
        title={t('rules.title', 'Padel Rules & Regulations')}
        description={t('rules.subtitle', 'Learn the official rules of padel, scoring, court dimensions, and more.')}
        url="/padel-rules"
      />

      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('rules.title', 'Padel Rules & Regulations')}</h1>
            <p className="text-xl text-muted-foreground">{t('rules.subtitle', 'Everything you need to know about the rules of padel.')}</p>
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
          ) : articles.length === 0 ? (
            <div className="text-center py-16">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
                <BookOpen className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-semibold mb-2">{t('rules.empty', 'No rules articles yet')}</h2>
              <p className="text-muted-foreground">{t('rules.emptyDescription', 'Check back soon for padel rules content.')}</p>
            </div>
          ) : (
            <div className="space-y-12">
              {/* Hub pages */}
              {hubPages.length > 0 && (
                <div>
                  <div className="grid md:grid-cols-2 gap-6">
                    {hubPages.map((article, index) => (
                      <motion.div
                        key={article._id}
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: index * 0.1 }}
                      >
                        <LocalizedLink to={`/padel-rules/${article.slug}`}>
                          <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                            <CardContent className="p-6">
                              <Badge variant="secondary" className="mb-3">{t('rules.guide', 'Guide')}</Badge>
                              <CardTitle className="text-xl mb-2 hover:text-primary transition-colors">{article.h1}</CardTitle>
                              <CardDescription className="line-clamp-3 mb-4">{article.intro}</CardDescription>
                              <span className="text-sm text-primary font-medium flex items-center gap-1">
                                {t('rules.readMore', 'Read more')} <ArrowRight className="h-3 w-3" />
                              </span>
                            </CardContent>
                          </Card>
                        </LocalizedLink>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {/* Child pages */}
              {childPages.length > 0 && (
                <div>
                  <h2 className="text-2xl font-bold mb-6">{t('rules.specificRules', 'Specific Rules')}</h2>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {childPages.map((article, index) => (
                      <motion.div
                        key={article._id}
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: index * 0.05 }}
                      >
                        <LocalizedLink to={`/padel-rules/${article.slug}`}>
                          <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                            <CardContent className="p-6">
                              <CardTitle className="text-lg mb-2 hover:text-primary transition-colors line-clamp-2">{article.h1}</CardTitle>
                              <CardDescription className="line-clamp-2">{article.quickAnswer}</CardDescription>
                            </CardContent>
                          </Card>
                        </LocalizedLink>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-xl mx-auto" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h2 className="text-2xl font-bold mb-4">{t('rules.ctaTitle', 'Ready to play by the rules?')}</h2>
            <p className="text-muted-foreground mb-6">{t('rules.ctaDescription', 'Find a certified padel trainer near you.')}</p>
            <Button asChild>
              <LocalizedLink to="/trainers" className="flex items-center gap-2">
                {t('blog.findTrainers', 'Find Trainers')}
                <ArrowRight className="h-4 w-4" />
              </LocalizedLink>
            </Button>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
