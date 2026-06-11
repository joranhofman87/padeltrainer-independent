import { useState } from 'react';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { ClubSearch } from '@/components/ratecourt/ClubSearch';
import { RatingForm } from '@/components/ratecourt/RatingForm';
import { useSubmitReview, useUserReviewForLocation, CourtReviewInsert } from '@/hooks/useCourtReviews';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Check, ArrowLeft, Star } from 'lucide-react';
import { LocalizedLink } from '@/components/LocalizedLink';
import { useNavigate, useParams } from 'react-router-dom';
import { useLocalizedPath } from '@/hooks/useLocalizedPath';
import { toast } from '@/hooks/use-toast';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { MARKETING_DOMAIN } from '@/lib/domains';

interface SelectedLocation {
  id: string;
  name: string;
  city: string;
  country: string;
  slug: string;
}

type Step = 'search' | 'rate' | 'auth' | 'done';

export default function RateMyCourtPage() {
  const { t } = useTranslation('marketing');
  const { user } = useAuth();
  const navigate = useNavigate();
  const { lang = 'en' } = useParams<{ lang: string }>();
  const authPath = useLocalizedPath('/auth');
  const [step, setStep] = useState<Step>('search');
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null);

  const breadcrumb = buildBreadcrumbList([
    { name: t('nav.home', 'Home'), url: `${MARKETING_DOMAIN}/${lang}` },
    { name: t('playground.title', 'Padel Playground'), url: `${MARKETING_DOMAIN}/${lang}/playground` },
    { name: t('rateMyCourtPage.title', 'Rate My Padel Court') },
  ]);
  const webAppSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: t('rateMyCourtPage.title', 'Rate My Padel Court'),
    description: t('rateMyCourtPage.seo.description', 'Rate your padel club across 10 categories.'),
    applicationCategory: 'LifestyleApplication',
    operatingSystem: 'Web',
    url: `${MARKETING_DOMAIN}/${lang}/playground/rate-my-court`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  };
  const [_pendingReview, setPendingReview] = useState<CourtReviewInsert | null>(null);

  const { data: existingReview } = useUserReviewForLocation(selectedLocation?.id);
  const submitReview = useSubmitReview();

  const handleSelectLocation = (loc: SelectedLocation) => {
    setSelectedLocation(loc);
    setStep('rate');
  };

  const handleSubmitRating = (data: CourtReviewInsert) => {
    if (!user) {
      setPendingReview(data);
      setStep('auth');
      return;
    }
    doSubmit(data);
  };

  const doSubmit = (data: CourtReviewInsert) => {
    submitReview.mutate(data, {
      onSuccess: () => {
        setStep('done');
      },
      onError: (err: any) => {
        if (err?.code === '23505') {
          toast({ title: t('rateMyCourtPage.alreadyReviewed', 'You already reviewed this club!'), variant: 'destructive' });
        } else {
          toast({ title: t('rateMyCourtPage.error', 'Something went wrong. Please try again.'), variant: 'destructive' });
        }
      },
    });
  };

  const handleBack = () => {
    if (step === 'rate') {
      setStep('search');
      setSelectedLocation(null);
    }
  };

  const handleRateAnother = () => {
    setStep('search');
    setSelectedLocation(null);
    setPendingReview(null);
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('rateMyCourtPage.seo.title', 'Rate My Padel Court | PadelTrainer.ai')}
        description={t('rateMyCourtPage.seo.description', 'Rate your padel club across 10 categories. Help other players find the best courts.')}
        url={`/${lang}/playground/rate-my-court`}
        structuredData={[breadcrumb, webAppSchema]}
      />
      <div className="container mx-auto px-4 py-16 md:py-24 max-w-xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
            ⭐ {t('rateMyCourtPage.title', 'Rate My Padel Court')}
          </h1>
          <p className="text-muted-foreground">
            {t('rateMyCourtPage.subtitle', 'Help the community by rating your club across 10 categories.')}
          </p>
        </div>

        {/* Step 1: Search */}
        {step === 'search' && (
          <ClubSearch onSelect={handleSelectLocation} />
        )}

        {/* Step 2: Rate */}
        {step === 'rate' && selectedLocation && (
          <div>
            <button onClick={handleBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
              <ArrowLeft className="h-4 w-4" /> {t('rateMyCourtPage.back', 'Back')}
            </button>

            {existingReview ? (
              <div className="text-center py-8 space-y-3">
                <Check className="h-10 w-10 text-primary mx-auto" />
                <p className="text-foreground font-medium">
                  {t('rateMyCourtPage.alreadyReviewed', 'You already reviewed this club!')}
                </p>
                <Button variant="outline" onClick={handleRateAnother}>
                  {t('rateMyCourtPage.rateAnother', 'Rate another club')}
                </Button>
              </div>
            ) : (
              <RatingForm
                locationName={`${selectedLocation.name} — ${selectedLocation.city}`}
                locationId={selectedLocation.id}
                onSubmit={handleSubmitRating}
                isSubmitting={submitReview.isPending}
              />
            )}
          </div>
        )}

        {/* Step 3: Auth gate */}
        {step === 'auth' && (
          <div className="text-center py-8 space-y-4">
            <Star className="h-10 w-10 text-primary mx-auto" />
            <h2 className="text-xl font-semibold text-foreground">
              {t('rateMyCourtPage.signInTitle', 'Sign in to submit your review')}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t('rateMyCourtPage.signInSubtitle', 'We need to verify your identity. Your review will be submitted right after.')}
            </p>
            <Button onClick={() => navigate(authPath)} size="lg">
              {t('rateMyCourtPage.signIn', 'Sign In / Sign Up')}
            </Button>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 'done' && (
          <div className="text-center py-8 space-y-4">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
              <Check className="h-8 w-8 text-primary" />
            </div>
            <h2 className="text-xl font-semibold text-foreground">
              {t('rateMyCourtPage.thankYou', 'Thank you for your review!')}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t('rateMyCourtPage.pendingApproval', 'Your review is pending approval and will be visible soon.')}
            </p>
            <div className="flex gap-3 justify-center">
              <Button variant="outline" onClick={handleRateAnother}>
                {t('rateMyCourtPage.rateAnother', 'Rate another club')}
              </Button>
              {selectedLocation && (
                <LocalizedLink to={`/clubs/${selectedLocation.slug}`}>
                  <Button variant="default">
                    {t('rateMyCourtPage.viewClub', 'View Club Page')}
                  </Button>
                </LocalizedLink>
              )}
            </div>
          </div>
        )}
      </div>
    </MarketingLayout>
  );
}
