import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { BookOpen, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, RULES_LIST_QUERY } from '@/lib/sanity';
import { MARKETING_DOMAIN } from '@/lib/domains';

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
  const { t, i18n } = useTranslation('marketing');
  const lang = i18n.language || 'en';

  const { data: articles = [], isLoading } = useQuery({
    queryKey: ['rules-articles', lang],
    queryFn: () => sanityClient.fetch<RulesArticle[]>(RULES_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const hubPages = articles.filter(a => a.pageType === 'hub');
  const childPages = articles.filter(a => a.pageType === 'child');

  const breadcrumbListSD = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": t('nav.home', 'Home'), "item": `${MARKETING_DOMAIN}/${lang}` },
      { "@type": "ListItem", "position": 2, "name": t('rules.breadcrumbLearn', 'Learn'), "item": `${MARKETING_DOMAIN}/${lang}/learn` },
      { "@type": "ListItem", "position": 3, "name": t('rules.title', 'Padel Rules & Regulations') },
    ],
  };

  const faqSD = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": t('rules.faq.q1', 'What is the correct serving height in padel?'), "acceptedAnswer": { "@type": "Answer", "text": t('rules.faq.a1', 'In padel, the serve must be hit at or below waist height. The ball must bounce on the ground before being struck, and the server must stand behind the service line.') } },
      { "@type": "Question", "name": t('rules.faq.q2', 'How many bounces are allowed on the serve in padel?'), "acceptedAnswer": { "@type": "Answer", "text": t('rules.faq.a2', 'The serve must bounce once in the diagonal service box before the receiver hits it. After the serve, the ball can bounce off the walls but must only bounce on the ground once before being returned.') } },
      { "@type": "Question", "name": t('rules.faq.q3', 'What happens if the ball hits the net in padel?'), "acceptedAnswer": { "@type": "Answer", "text": t('rules.faq.a3', 'During a rally, if the ball hits the net and lands in the correct area, play continues. On a serve, if the ball hits the net and lands in the correct service box, it is a let and the serve is replayed.') } },
      { "@type": "Question", "name": t('rules.faq.q4', 'Can you hit the ball off the walls in padel?'), "acceptedAnswer": { "@type": "Answer", "text": t('rules.faq.a4', 'Yes! The walls are in play in padel. After the ball bounces on the ground, it can hit the back or side walls, and you can still play it. This is one of the unique and exciting aspects of padel.') } },
      { "@type": "Question", "name": t('rules.faq.q5', 'How does scoring work in padel?'), "acceptedAnswer": { "@type": "Answer", "text": t('rules.faq.a5', 'Padel uses the same scoring system as tennis: 15, 30, 40, game. Matches are typically best of 3 sets, with each set played to 6 games. A tiebreak is played at 6-6.') } },
    ],
  };

  const itemListSD = articles.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": t('rules.title', 'Padel Rules & Regulations'),
    "itemListElement": articles.map((a, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": a.h1,
      "url": `${MARKETING_DOMAIN}/${lang}/padel-rules/${a.slug}`,
    })),
  } : undefined;

  const structuredData = [breadcrumbListSD, faqSD, ...(itemListSD ? [itemListSD] : [])];

  return (
    <MarketingLayout>
      <SEO
        title={t('rules.title', 'Padel Rules & Regulations')}
        description={t('rules.metaDescription', 'Learn the official padel court rules, serving regulations, and scoring system. Master the fundamentals every player needs to know.')}
        url="/padel-rules"
        structuredData={structuredData}
      />

      {/* Hero */}
      <section className="py-16 bg-background">
        <div className="container mx-auto px-4">
          <Breadcrumbs items={[
            { label: t('rules.breadcrumbLearn', 'Learn'), href: '/learn' },
            { label: t('rules.title', 'Padel Rules & Regulations') },
          ]} />
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('rules.title', 'Padel Rules & Regulations')}</h1>
            <p className="text-xl text-muted-foreground mb-6">{t('rules.subtitle', 'Everything you need to know about the rules of padel.')}</p>
            <p className="text-base text-muted-foreground max-w-2xl mx-auto">
              {t('rules.introText', 'Padel rules govern everything from court dimensions to scoring and serving regulations. Whether you\'re new to the sport or brushing up on the fundamentals, this guide covers the essential rules you need to know. Understanding the rules is the first step to playing confidently and fairly.')}
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
              {hubPages.length > 0 && (
                <div>
                  <div className="grid md:grid-cols-2 gap-6">
                    {hubPages.map((article, index) => (
                      <motion.div key={article._id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.1 }}>
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

              {childPages.length > 0 && (
                <div>
                  <h2 className="text-2xl font-bold mb-6">{t('rules.specificRules', 'Specific Rules')}</h2>
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {childPages.map((article, index) => (
                      <motion.div key={article._id} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.05 }}>
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

      {/* Related Learning */}
      <section className="py-12 border-t">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl font-bold mb-6">{t('rules.relatedLearning', 'Related Learning')}</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            <LocalizedLink to="/padel-strokes" className="flex items-center gap-2 p-4 rounded-lg border hover:border-primary/20 hover:bg-accent/50 transition-colors">
              <ArrowRight className="h-4 w-4 text-primary shrink-0" />
              <span className="font-medium">{t('rules.relatedStrokes', 'Master Padel Strokes & Techniques')}</span>
            </LocalizedLink>
            <LocalizedLink to="/video-tips" className="flex items-center gap-2 p-4 rounded-lg border hover:border-primary/20 hover:bg-accent/50 transition-colors">
              <ArrowRight className="h-4 w-4 text-primary shrink-0" />
              <span className="font-medium">{t('rules.relatedVideoTips', 'Watch Video Tips & Tutorials')}</span>
            </LocalizedLink>
            <LocalizedLink to="/blog" className="flex items-center gap-2 p-4 rounded-lg border hover:border-primary/20 hover:bg-accent/50 transition-colors">
              <ArrowRight className="h-4 w-4 text-primary shrink-0" />
              <span className="font-medium">{t('rules.relatedBlog', 'Read the Latest Blog Posts')}</span>
            </LocalizedLink>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-12 bg-accent/30">
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
