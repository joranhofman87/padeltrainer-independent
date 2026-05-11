import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { motion } from 'framer-motion';
import { BookOpen, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sanityClient, RULES_LIST_QUERY } from '@/lib/sanity';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { MarketingHero, MarketingSection, MarketingFinalCTA } from '@/components/marketing/sections';

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

  const hubPages = articles.filter((a) => a.pageType === 'hub');
  const childPages = articles.filter((a) => a.pageType === 'child');

  const breadcrumbListSD = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('nav.home', 'Home'), item: `${MARKETING_DOMAIN}/${lang}` },
      { '@type': 'ListItem', position: 2, name: t('rules.breadcrumbLearn', 'Learn'), item: `${MARKETING_DOMAIN}/${lang}/learn` },
      { '@type': 'ListItem', position: 3, name: t('rules.title', 'Padel Rules & Regulations') },
    ],
  };

  const faqSD = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: t('rules.faq.q1'), acceptedAnswer: { '@type': 'Answer', text: t('rules.faq.a1') } },
      { '@type': 'Question', name: t('rules.faq.q2'), acceptedAnswer: { '@type': 'Answer', text: t('rules.faq.a2') } },
      { '@type': 'Question', name: t('rules.faq.q3'), acceptedAnswer: { '@type': 'Answer', text: t('rules.faq.a3') } },
      { '@type': 'Question', name: t('rules.faq.q4'), acceptedAnswer: { '@type': 'Answer', text: t('rules.faq.a4') } },
      { '@type': 'Question', name: t('rules.faq.q5'), acceptedAnswer: { '@type': 'Answer', text: t('rules.faq.a5') } },
    ],
  };

  const itemListSD =
    articles.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: t('rules.title', 'Padel Rules & Regulations'),
          itemListElement: articles.map((a, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: a.h1,
            url: `${MARKETING_DOMAIN}/${lang}/padel-rules/${a.slug}`,
          })),
        }
      : undefined;

  const structuredData = [breadcrumbListSD, faqSD, ...(itemListSD ? [itemListSD] : [])];

  return (
    <MarketingLayout>
      <SEO
        title={t('rules.title', 'Padel Rules & Regulations')}
        description={t('rules.metaDescription', 'Learn the official padel court rules, serving regulations, and scoring system. Master the fundamentals every player needs to know.')}
        url="/padel-rules"
        structuredData={structuredData}
      />

      <MarketingHero
        eyebrow={t('rules.eyebrow', 'Official rules')}
        title={t('rules.title', 'Padel Rules & Regulations')}
        subtitle={t('rules.subtitle', 'Everything you need to know about the rules of padel.')}
        compact
      />

      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <Breadcrumbs
          items={[
            { label: t('rules.breadcrumbLearn', 'Learn'), href: '/learn' },
            { label: t('rules.title', 'Padel Rules & Regulations') },
          ]}
        />
      </div>

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
        ) : articles.length === 0 ? (
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-navy-50 mb-4">
              <BookOpen className="h-8 w-8 text-navy-500" />
            </div>
            <h2 className="font-display text-xl font-bold text-navy-900 mb-2">
              {t('rules.empty', 'No rules articles yet')}
            </h2>
            <p className="text-navy-600">{t('rules.emptyDescription', 'Check back soon for padel rules content.')}</p>
          </div>
        ) : (
          <div className="space-y-12">
            {hubPages.length > 0 && (
              <div className="grid md:grid-cols-2 gap-6">
                {hubPages.map((article, index) => (
                  <motion.div
                    key={article._id}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: index * 0.08 }}
                  >
                    <LocalizedLink to={`/padel-rules/${article.slug}`} className="block group h-full">
                      <div className="card-chip p-6 h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
                        <span className="inline-block text-xs rounded-full bg-brand-50 text-brand-700 px-2.5 py-1 font-semibold uppercase tracking-wide mb-3">
                          {t('rules.guide', 'Guide')}
                        </span>
                        <h3 className="font-display text-xl font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors">
                          {article.h1}
                        </h3>
                        <p className="text-navy-600 line-clamp-3 mb-4">{article.intro}</p>
                        <span className="text-sm text-brand-600 font-semibold inline-flex items-center gap-1">
                          {t('rules.readMore', 'Read more')} <ArrowRight className="h-3 w-3" />
                        </span>
                      </div>
                    </LocalizedLink>
                  </motion.div>
                ))}
              </div>
            )}

            {childPages.length > 0 && (
              <div>
                <h2 className="font-display text-2xl md:text-3xl font-extrabold tracking-[-0.02em] text-navy-900 mb-6">
                  {t('rules.specificRules', 'Specific Rules')}
                </h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {childPages.map((article, index) => (
                    <motion.div
                      key={article._id}
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ delay: index * 0.04 }}
                    >
                      <LocalizedLink to={`/padel-rules/${article.slug}`} className="block group h-full">
                        <div className="card-chip p-6 h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
                          <h3 className="font-display text-lg font-bold text-navy-900 mb-2 group-hover:text-brand-600 transition-colors line-clamp-2">
                            {article.h1}
                          </h3>
                          <p className="text-navy-600 text-sm line-clamp-2">{article.quickAnswer}</p>
                        </div>
                      </LocalizedLink>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </MarketingSection>

      <MarketingSection
        background="cream"
        heading={t('rules.relatedLearning', 'Related Learning')}
        align="left"
      >
        <div className="grid md:grid-cols-3 gap-4">
          {[
            { to: '/padel-strokes', label: t('rules.relatedStrokes', 'Master Padel Strokes & Techniques') },
            { to: '/video-tips', label: t('rules.relatedVideoTips', 'Watch Video Tips & Tutorials') },
            { to: '/blog', label: t('rules.relatedBlog', 'Read the Latest Blog Posts') },
          ].map((link) => (
            <LocalizedLink
              key={link.to}
              to={link.to}
              className="card-chip p-4 flex items-center gap-3 transition-all hover:-translate-y-0.5 hover:shadow-mock"
            >
              <ArrowRight className="h-4 w-4 text-brand-500 shrink-0" />
              <span className="font-semibold text-navy-900">{link.label}</span>
            </LocalizedLink>
          ))}
        </div>
      </MarketingSection>

      <MarketingFinalCTA
        title={t('rules.ctaTitle', 'Ready to play by the rules?')}
        body={t('rules.ctaDescription', 'Find a certified padel trainer near you.')}
        primaryHref={`/${lang}/trainers`}
        primaryLabel={
          <>
            {t('blog.findTrainers', 'Find Trainers')}
            <ArrowRight className="ml-2 h-5 w-5" />
          </>
        }
      />
    </MarketingLayout>
  );
}
