import { useEffect, lazy, Suspense } from 'react';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { trackEvent } from '@/lib/tracking';
import { HeroSection } from '@/components/home/HeroSection';
import { SocialProofStrip } from '@/components/home/SocialProofStrip';
import { BannerZone } from '@/components/sponsors/BannerZone';

// Lazy-load below-fold sections to reduce initial JS parsing on mobile
const PainStoriesSection = lazy(() => import('@/components/home/PainStoriesSection').then(m => ({ default: m.PainStoriesSection })));
const SolutionOverview = lazy(() => import('@/components/home/SolutionOverview').then(m => ({ default: m.SolutionOverview })));
const HowItWorksSection = lazy(() => import('@/components/home/HowItWorksSection').then(m => ({ default: m.HowItWorksSection })));
const JobsToBeDoneSection = lazy(() => import('@/components/home/JobsToBeDoneSection').then(m => ({ default: m.JobsToBeDoneSection })));
const PlayerBanner = lazy(() => import('@/components/home/PlayerBanner').then(m => ({ default: m.PlayerBanner })));
const PricingPreview = lazy(() => import('@/components/home/PricingPreview').then(m => ({ default: m.PricingPreview })));
const FAQSection = lazy(() => import('@/components/home/FAQSection').then(m => ({ default: m.FAQSection })));
const FinalCTASection = lazy(() => import('@/components/home/FinalCTASection').then(m => ({ default: m.FinalCTASection })));


export default function Home() {
  const { t } = useTranslation('marketing');

  useEffect(() => {
    trackEvent('home_page_viewed');
    const prefetch = () => {
      import('@/pages/Trainers');
      import('@/pages/TrainerProfile');
      import('@/pages/Locations');
    };
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(prefetch);
    } else {
      setTimeout(prefetch, 2000);
    }
  }, []);

  const websiteStructuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "PadelTrainer.ai",
    "url": "https://padeltrainer.ai",
    "description": t('homev2.hero.subheadline'),
    "potentialAction": {
      "@type": "SearchAction",
      "target": "https://padeltrainer.ai/trainers?search={search_term}",
      "query-input": "required name=search_term"
    }
  };

  const organizationStructuredData = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "PadelTrainer.ai",
    "url": "https://padeltrainer.ai",
    "logo": "https://padeltrainer.ai/favicon.png",
    "sameAs": [],
    "contactPoint": {
      "@type": "ContactPoint",
      "contactType": "customer service",
      "availableLanguage": ["Dutch", "English"]
    }
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('seo.home.title')}
        description={t('seo.home.description')}
        url="/"
        structuredData={[websiteStructuredData, organizationStructuredData]}
      />
      <HeroSection />
      <SocialProofStrip />
      <BannerZone zone="homepage-hero" className="container mx-auto px-4 py-6" />
      <Suspense fallback={null}>
        <PainStoriesSection />
        <SolutionOverview />
        <HowItWorksSection />
        <JobsToBeDoneSection />
        <PlayerBanner />
        <PricingPreview />
        <FAQSection />
        <FinalCTASection />
      </Suspense>
    </MarketingLayout>
  );
}
