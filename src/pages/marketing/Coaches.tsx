import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { ArrowRight, User, MapPin, Info } from 'lucide-react';
import { sanityClient, COACHES_LIST_QUERY } from '@/lib/sanity';
import { useTranslation } from 'react-i18next';
import type { SeoFields } from '@/lib/sanity';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { MarketingHero, MarketingSection } from '@/components/marketing/sections';

interface CoachListItem {
  _id: string;
  name: string;
  slug: string;
  bio: string | null;
  shortTagline: string | null;
  location: string | null;
  specialties: string[] | null;
  profileImageUrl: string | null;
  seo: SeoFields | null;
}

export default function Coaches() {
  const { i18n } = useTranslation();
  const lang = i18n.language || 'en';

  const { data: coaches = [], isLoading } = useQuery({
    queryKey: ['coaches-list', lang],
    queryFn: () => sanityClient.fetch<CoachListItem[]>(COACHES_LIST_QUERY, { lang }),
    staleTime: 1000 * 60 * 10,
  });

  const itemListStructuredData =
    coaches.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'Padel Coaches & Creators',
          itemListElement: coaches.map((c, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: c.name,
            url: `https://padeltrainer.ai/${lang}/padel-coaches/${c.slug}`,
          })),
        }
      : undefined;

  const breadcrumbSchema = buildBreadcrumbList([
    { name: 'Home', url: `/${lang}` },
    { name: 'Padel Coaches', url: `/${lang}/padel-coaches` },
  ]);

  const schemas = itemListStructuredData ? [itemListStructuredData, breadcrumbSchema] : [breadcrumbSchema];

  return (
    <MarketingLayout>
      <SEO
        title="Padel Content Creators"
        description="Discover independent padel coaches and content creators we feature for the quality of their tutorials, drills, and tips."
        url="/padel-coaches"
        structuredData={schemas}
      />

      <MarketingHero
        eyebrow="Creators we love"
        title="Padel Content Creators"
        subtitle="We curate the best padel content from independent coaches and creators. These creators are not affiliated with PadelTrainer.ai - we feature them because of the quality of their tutorials, drills, and tips."
      />

      <section className="max-w-3xl mx-auto px-4 md:px-6 -mt-6">
        <div className="flex items-start gap-3 rounded-2xl border border-navy-100 bg-card shadow-soft p-4 text-sm text-navy-600">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-brand-500" />
          <p>
            The creators featured on this page are independent content creators. They are not affiliated with or
            employed by PadelTrainer.ai. We showcase their content because of its quality and educational value.
          </p>
        </div>
      </section>

      <MarketingSection background="default">
        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card-chip p-6 flex flex-col items-center text-center">
                <Skeleton className="h-20 w-20 rounded-full mb-4" />
                <Skeleton className="h-5 w-32 mb-2" />
                <Skeleton className="h-4 w-full mb-4" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ))}
          </div>
        ) : coaches.length === 0 ? (
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-navy-50 mb-4">
              <User className="h-8 w-8 text-navy-500" />
            </div>
            <h2 className="font-display text-xl font-bold text-navy-900 mb-2">No coaches yet</h2>
            <p className="text-navy-600">Check back soon for coach profiles.</p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {coaches.map((coach, index) => (
              <motion.div
                key={coach._id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.05 }}
              >
                <LocalizedLink to={`/padel-coaches/${coach.slug}`} className="block group">
                  <div className="card-chip p-6 h-full flex flex-col items-center text-center transition-all group-hover:-translate-y-0.5 group-hover:shadow-mock">
                    <div className="h-20 w-20 rounded-full bg-navy-50 flex items-center justify-center mb-4 overflow-hidden">
                      {coach.profileImageUrl ? (
                        <img
                          src={coach.profileImageUrl}
                          alt={coach.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <User className="h-10 w-10 text-navy-500" />
                      )}
                    </div>

                    <h3 className="font-display text-lg font-bold text-navy-900 mb-1 group-hover:text-brand-600 transition-colors">
                      {coach.name}
                    </h3>

                    {coach.location && (
                      <p className="text-sm text-navy-500 flex items-center gap-1 mb-2">
                        <MapPin className="h-3 w-3" />
                        {coach.location}
                      </p>
                    )}

                    {coach.shortTagline && (
                      <p className="text-sm text-navy-600 italic mb-3 line-clamp-2">"{coach.shortTagline}"</p>
                    )}

                    {!coach.shortTagline && coach.specialties && coach.specialties.length > 0 && (
                      <div className="flex flex-wrap gap-1 justify-center mb-3">
                        {coach.specialties.slice(0, 3).map((s) => (
                          <span
                            key={s}
                            className="text-xs rounded-full bg-brand-50 text-brand-700 px-2 py-0.5 font-medium"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    )}

                    {!coach.shortTagline && !coach.specialties?.length && coach.bio && (
                      <p className="text-sm text-navy-600 line-clamp-2 mb-3">{coach.bio}</p>
                    )}

                    <span className="text-sm text-brand-600 font-semibold flex items-center gap-1 mt-auto">
                      View profile <ArrowRight className="h-3 w-3" />
                    </span>
                  </div>
                </LocalizedLink>
              </motion.div>
            ))}
          </div>
        )}
      </MarketingSection>
    </MarketingLayout>
  );
}
