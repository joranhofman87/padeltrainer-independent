import { useQuery } from '@tanstack/react-query';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { ArrowRight, User, MapPin, Info } from 'lucide-react';
import { sanityClient, COACHES_LIST_QUERY } from '@/lib/sanity';
import type { SeoFields } from '@/lib/sanity';

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
  const { data: coaches = [], isLoading } = useQuery({
    queryKey: ['coaches-list'],
    queryFn: () => sanityClient.fetch<CoachListItem[]>(COACHES_LIST_QUERY),
    staleTime: 1000 * 60 * 10,
  });

  const itemListStructuredData = coaches.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Padel Coaches & Creators",
    "itemListElement": coaches.map((c, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": c.name,
      "url": `https://padeltrainer.ai/padel-coaches/${c.slug}`,
    })),
  } : undefined;

  return (
    <MarketingLayout>
      <SEO
        title="Padel Content Creators"
        description="Discover independent padel coaches and content creators we feature for the quality of their tutorials, drills, and tips."
        url="/padel-coaches"
        structuredData={itemListStructuredData}
      />

      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div className="text-center max-w-3xl mx-auto" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Padel Coaches & Creators</h1>
            <p className="text-xl text-muted-foreground">
              Discover top padel coaches and content creators sharing tips, drills, and tutorials.
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
                  <CardContent className="p-6 flex flex-col items-center text-center">
                    <Skeleton className="h-20 w-20 rounded-full mb-4" />
                    <Skeleton className="h-5 w-32 mb-2" />
                    <Skeleton className="h-4 w-full mb-4" />
                    <Skeleton className="h-4 w-3/4" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : coaches.length === 0 ? (
            <div className="text-center py-16">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
                <User className="h-8 w-8 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-semibold mb-2">No coaches yet</h2>
              <p className="text-muted-foreground">Check back soon for coach profiles.</p>
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
                  <LocalizedLink to={`/padel-coaches/${coach.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <CardContent className="p-6 flex flex-col items-center text-center">
                        {/* Avatar */}
                        <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center mb-4 overflow-hidden">
                          {coach.profileImageUrl ? (
                            <img
                              src={coach.profileImageUrl}
                              alt={coach.name}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <User className="h-10 w-10 text-muted-foreground" />
                          )}
                        </div>

                        <CardTitle className="text-lg mb-1 hover:text-primary transition-colors">
                          {coach.name}
                        </CardTitle>

                        {coach.location && (
                          <p className="text-sm text-muted-foreground flex items-center gap-1 mb-2">
                            <MapPin className="h-3 w-3" />
                            {coach.location}
                          </p>
                        )}

                        {coach.shortTagline && (
                          <p className="text-sm text-muted-foreground italic mb-3 line-clamp-2">
                            "{coach.shortTagline}"
                          </p>
                        )}

                        {!coach.shortTagline && coach.specialties && coach.specialties.length > 0 && (
                          <div className="flex flex-wrap gap-1 justify-center mb-3">
                            {coach.specialties.slice(0, 3).map(s => (
                              <Badge key={s} variant="outline" className="text-xs">{s}</Badge>
                            ))}
                          </div>
                        )}

                        {!coach.shortTagline && !coach.specialties?.length && coach.bio && (
                          <CardDescription className="line-clamp-2 mb-3">
                            {coach.bio}
                          </CardDescription>
                        )}

                        <span className="text-sm text-primary font-medium flex items-center gap-1 mt-auto">
                          View profile <ArrowRight className="h-3 w-3" />
                        </span>
                      </CardContent>
                    </Card>
                  </LocalizedLink>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </section>
    </MarketingLayout>
  );
}
