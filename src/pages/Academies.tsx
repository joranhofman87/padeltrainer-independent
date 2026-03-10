import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, MapPin, Users, Search, CheckCircle, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { SEO } from '@/components/SEO';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { getPublicAcademies, type AcademyProfile } from '@/lib/academy';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { FeaturedSection, FeaturedBadge, shuffleArray } from '@/components/featured/FeaturedSection';
import { logger } from '@/lib/logger';

const MAX_FEATURED = 8;

export default function Academies() {
  const { t } = useTranslation(['academy', 'common']);
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();

  const [academies, setAcademies] = useState<Partial<AcademyProfile>[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchAcademies = async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await getPublicAcademies();
      setAcademies(data);
    } catch (error) {
      logger.error('Error fetching academies', error instanceof Error ? error : new Error(String(error)), { component: 'Academies' });
      setError('Failed to load academies. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAcademies();
  }, []);

  const filteredAcademies = academies.filter(academy =>
    (academy.name?.toLowerCase().includes(searchQuery.toLowerCase())) ||
    (academy.description?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Featured academies (paid/active subscription)
  const featuredAcademies = useMemo(() => {
    const featured = academies.filter(a => a.subscription_status === 'active');
    return shuffleArray(featured).slice(0, MAX_FEATURED);
  }, [academies]);

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Padel Training Academies",
    "description": "Find professional padel training academies in the Netherlands",
    "numberOfItems": academies.length,
    "itemListElement": academies.slice(0, 10).map((academy, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "EducationalOrganization",
        "name": academy.name || "",
        "description": academy.description,
        "url": `https://padeltrainer.ai/academies/${academy.slug}`,
        ...(academy.logo_url && { "logo": academy.logo_url })
      }
    }))
  };

  return (
    <>
      <SEO
        title={t('common:academies', 'Padel Training Academies')}
        description="Find professional padel training academies with certified trainers. Compare academies, view their trainers, and book lessons."
        url="/academies"
        structuredData={structuredData}
      />

      <MarketingLayout>
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="text-center mb-8">
            <Badge variant="secondary" className="mb-4">
              <Building2 className="h-3 w-3 mr-1" />
              {t('badge')}
            </Badge>
            <h1 className="text-3xl md:text-4xl font-bold mb-4">
              {t('common:findAcademies', 'Find Padel Academies')}
            </h1>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              {t('common:academiesDescription', 'Discover professional padel training academies with certified trainers and multiple locations.')}
            </p>
          </div>

          {/* Search */}
          <div className="max-w-xl mx-auto mb-8">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('common:searchAcademies', 'Search academies...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          {/* Featured Academies Section */}
          {!loading && featuredAcademies.length > 0 && !searchQuery && (
            <FeaturedSection
              title={t('common:featured.academies')}
              description={t('common:featured.academiesDescription')}
              className="mb-8 max-w-6xl mx-auto"
            >
              {featuredAcademies.map((academy) => (
                <Card
                  key={academy.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50 w-[280px] lg:w-auto flex-shrink-0"
                  onClick={() => navigate(localizePath(`/academies/${academy.slug}`))}
                >
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-4">
                      <Avatar className="h-16 w-16 rounded-lg bg-muted">
                        <AvatarImage src={academy.logo_url || ''} className="object-cover" />
                        <AvatarFallback className="rounded-lg text-lg">{getInitials(academy.name || "")}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold truncate">{academy.name || ""}</h3>
                          {(academy.is_verified || academy.subscription_status === 'active') && (
                            <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                        </div>
                        {academy.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                            {academy.description}
                          </p>
                        )}
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          {academy.website_url && (
                            <span className="truncate max-w-[150px]">
                              {academy.website_url.replace(/^https?:\/\//, '').split('/')[0]}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </FeaturedSection>
          )}

          {/* Results */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Card key={i}>
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-4">
                      <Skeleton className="h-16 w-16 rounded-lg" />
                      <div className="flex-1">
                        <Skeleton className="h-5 w-32 mb-2" />
                        <Skeleton className="h-4 w-24 mb-2" />
                        <Skeleton className="h-4 w-full" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-16">
              <Building2 className="h-16 w-16 mx-auto text-destructive mb-4" />
              <h3 className="text-lg font-semibold mb-2">{t('common:errorLoadingAcademies', 'Error loading academies')}</h3>
              <p className="text-muted-foreground mb-6">{error}</p>
              <Button onClick={fetchAcademies}>
                {t('common:tryAgain', 'Try Again')}
              </Button>
            </div>
          ) : filteredAcademies.length === 0 ? (
            <div className="text-center py-16">
              <Building2 className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">{t('common:noAcademiesFound', 'No academies found')}</h3>
              <p className="text-muted-foreground mb-6">
                {searchQuery 
                  ? t('common:tryDifferentSearch', 'Try a different search term')
                  : t('common:noAcademiesYet', 'There are no public academies yet.')
                }
              </p>
              {searchQuery && (
                <Button variant="outline" onClick={() => setSearchQuery('')}>
                  {t('common:clearSearch', 'Clear Search')}
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredAcademies.map((academy) => (
                <Card
                  key={academy.id}
                  className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
                  onClick={() => navigate(localizePath(`/academies/${academy.slug}`))}
                >
                  <CardContent className="pt-6">
                    <div className="flex items-start gap-4">
                      <Avatar className="h-16 w-16 rounded-lg bg-muted">
                        <AvatarImage src={academy.logo_url || ''} className="object-cover" />
                        <AvatarFallback className="rounded-lg text-lg">{getInitials(academy.name || "")}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold truncate">{academy.name || ""}</h3>
                          {(academy.is_verified || academy.subscription_status === 'active') && (
                            <CheckCircle className="h-4 w-4 text-primary flex-shrink-0" />
                          )}
                        </div>
                        {academy.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                            {academy.description}
                          </p>
                        )}
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          {academy.website_url && (
                            <span className="truncate max-w-[150px]">
                              {academy.website_url.replace(/^https?:\/\//, '').split('/')[0]}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </MarketingLayout>
    </>
  );
}
