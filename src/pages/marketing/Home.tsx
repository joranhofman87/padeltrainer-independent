import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { useTranslation } from 'react-i18next';
import { HeroSection } from '@/components/home/HeroSection';
import { SocialProofStrip } from '@/components/home/SocialProofStrip';
import { ChaosPainSection } from '@/components/home/ChaosPainSection';
import { ImpactSection } from '@/components/home/ImpactSection';
import { SolutionOverview } from '@/components/home/SolutionOverview';
import { WhyPadelTrainerSection } from '@/components/home/WhyPadelTrainerSection';
import { HowItWorksSection } from '@/components/home/HowItWorksSection';
import { PadelRealitiesSection } from '@/components/home/PadelRealitiesSection';
import { JobsToBeDoneSection } from '@/components/home/JobsToBeDoneSection';
import { CriticalEventsSection } from '@/components/home/CriticalEventsSection';
import { PricingPreview } from '@/components/home/PricingPreview';
import { FAQSection } from '@/components/home/FAQSection';
import { FinalCTASection } from '@/components/home/FinalCTASection';
import { HomeFeaturedSections } from '@/components/home/HomeFeaturedSections';

export default function Home() {
  const { t } = useTranslation('marketing');

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
        title="Padel Trainer — Scheduling, Bookings & Payments for Padel Trainers"
        description="Run your padel coaching business from one place. Online booking, secure payments, calendar sync, and fewer no-shows. Free trial, then from €9/month."
        url="/"
        structuredData={[websiteStructuredData, organizationStructuredData]}
      />
      <HeroSection />
      <SocialProofStrip />
      <ChaosPainSection />
      <ImpactSection />
      <SolutionOverview />
      <WhyPadelTrainerSection />
      <HowItWorksSection />
      <PadelRealitiesSection />
      <JobsToBeDoneSection />
      <CriticalEventsSection />
      <PricingPreview />
      <FAQSection />
      <FinalCTASection />
      <HomeFeaturedSections />
    </MarketingLayout>
  );
}
