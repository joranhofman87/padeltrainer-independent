import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, MapPin, Users, Globe } from 'lucide-react';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { getProvinceBySlug, PROVINCES, type Province } from '@/lib/provinces';
import { getCitiesWithTrainers, type CityWithTrainerCount } from '@/lib/cities';

export default function TrainersProvince() {
  const { province } = useParams<{ province: string }>();
  const [citiesData, setCitiesData] = useState<CityWithTrainerCount[]>([]);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation('marketing');
  const currentLang = useCurrentLanguage();

  const provinceData = useMemo(() => {
    if (!province) return undefined;
    return getProvinceBySlug(province);
  }, [province]);

  useEffect(() => {
    fetchCities();
  }, [province]);

  const fetchCities = async () => {
    setLoading(true);
    const allCities = await getCitiesWithTrainers();
    
    if (provinceData) {
      // Filter to cities in this province
      const provinceCitySlugs = new Set(provinceData.cities);
      const matchedCities = allCities.filter(c => provinceCitySlugs.has(c.slug));
      setCitiesData(matchedCities);
    }
    setLoading(false);
  };

  if (!provinceData) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-12 text-center">
          <h1 className="text-2xl font-bold mb-4">{t('cityPage.noTrainersFound', { city: province })}</h1>
          <LocalizedLink to="/trainers" className="text-primary hover:underline">
            {t('cityPage.viewAllTrainers')}
          </LocalizedLink>
        </div>
      </MarketingLayout>
    );
  }

  const totalTrainers = citiesData.reduce((sum, c) => sum + c.trainerCount, 0);
  const totalLocations = citiesData.reduce((sum, c) => sum + c.locationCount, 0);

  // Other provinces in the same country for internal linking
  const relatedProvinces = PROVINCES
    .filter(p => p.country === provinceData.country && p.slug !== provinceData.slug)
    .slice(0, 6);

  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": `Padel Trainers in ${provinceData.name}`,
      "description": `Find padel trainers across ${citiesData.length} cities in ${provinceData.name}.`,
      "numberOfItems": citiesData.length,
      "itemListElement": citiesData.slice(0, 20).map((city, index) => ({
        "@type": "ListItem",
        "position": index + 1,
        "item": {
          "@type": "Place",
          "name": city.city,
          "address": { "@type": "PostalAddress", "addressLocality": city.city, "addressRegion": provinceData.name }
        }
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": t('cityPage.home'), "item": `https://padeltrainer.ai/${currentLang}` },
        { "@type": "ListItem", "position": 2, "name": t('cityPage.trainers'), "item": `https://padeltrainer.ai/${currentLang}/trainers` },
        { "@type": "ListItem", "position": 3, "name": provinceData.name }
      ]
    }
  ];

  return (
    <MarketingLayout>
      <SEO
        title={`Padel Trainers in ${provinceData.name} | Find & Book Lessons`}
        description={`Find ${totalTrainers} padel trainers across ${citiesData.length} cities in ${provinceData.name}. Compare rates, read reviews, and book lessons.`}
        url={`/trainers/region/${provinceData.slug}`}
        structuredData={structuredData}
      />

      {/* Breadcrumbs */}
      <div className="border-b bg-muted/30">
        <div className="container mx-auto px-4 py-3">
          <nav className="flex items-center gap-2 text-sm text-muted-foreground">
            <LocalizedLink to="/" className="hover:text-primary transition-colors">{t('cityPage.home')}</LocalizedLink>
            <ChevronRight className="h-4 w-4" />
            <LocalizedLink to="/trainers" className="hover:text-primary transition-colors">{t('cityPage.trainers')}</LocalizedLink>
            <ChevronRight className="h-4 w-4" />
            <span className="text-foreground font-medium">{provinceData.name}</span>
          </nav>
        </div>
      </div>

      <main className="container mx-auto px-4 py-8">
        {/* Hero */}
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            Padel Trainers in {provinceData.name}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            {totalTrainers > 0
              ? `Discover ${totalTrainers} padel trainers across ${citiesData.length} cities in ${provinceData.name}. Find the perfect trainer near you.`
              : `Explore padel training options across ${provinceData.name}.`
            }
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">{totalTrainers}</div>
              <div className="text-sm text-muted-foreground">{t('cityPage.trainers')}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">{citiesData.length}</div>
              <div className="text-sm text-muted-foreground">Cities</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-primary">{totalLocations}</div>
              <div className="text-sm text-muted-foreground">Clubs</div>
            </CardContent>
          </Card>
        </div>

        {/* Cities Grid */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {citiesData.map(city => (
              <LocalizedLink
                key={city.slug}
                to={`/trainers/${city.slug}`}
                className="block"
              >
                <Card className="hover:border-primary/50 hover:shadow-md transition-all h-full">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-primary" />
                      {city.city}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {city.trainerCount} {city.trainerCount !== 1 ? t('cityPage.trainers').toLowerCase() : 'trainer'}
                      </span>
                      <span>{city.locationCount} club{city.locationCount !== 1 ? 's' : ''}</span>
                    </div>
                  </CardContent>
                </Card>
              </LocalizedLink>
            ))}
          </div>
        )}

        {/* Related Provinces */}
        {relatedProvinces.length > 0 && (
          <section className="mt-12">
            <h2 className="text-2xl font-semibold mb-2 flex items-center gap-2">
              <Globe className="h-6 w-6" />
              {t('cityPage.nearbyCitiesTitle')}
            </h2>
            <p className="text-muted-foreground mb-6">Explore other regions</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {relatedProvinces.map(p => (
                <LocalizedLink
                  key={p.slug}
                  to={`/trainers/region/${p.slug}`}
                  className="block p-4 rounded-lg border bg-card hover:border-primary/50 hover:shadow-md transition-all"
                >
                  <div className="font-medium text-foreground">{p.name}</div>
                  <Badge variant="outline" className="mt-1 text-xs">{p.cities.length} cities</Badge>
                </LocalizedLink>
              ))}
            </div>
          </section>
        )}
      </main>
    </MarketingLayout>
  );
}
