import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Trophy, Gift, CreditCard, Star, CheckCircle, ArrowRight } from 'lucide-react';
import { getAppUrl } from '@/lib/domains';
import { MARKETING_DOMAIN } from '@/lib/domains';

const SPOTS_CLAIMED = 23;
const TOTAL_SPOTS = 100;
const SPOTS_REMAINING = TOTAL_SPOTS - SPOTS_CLAIMED;

export default function FoundingTrainers() {
  const { t } = useTranslation('marketing');
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang || 'en';
  const signupUrl = getAppUrl('/signup/trainer?ref=founding100');

  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'Founding 100 Trainers',
      description: t('foundingTrainers.metaDescription'),
      url: `${MARKETING_DOMAIN}/${currentLang}/founding-trainers`,
      publisher: {
        '@type': 'Organization',
        name: 'PadelTrainer.ai',
        logo: { '@type': 'ImageObject', url: `${MARKETING_DOMAIN}/favicon.png` },
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: t('nav.home', 'Home'), item: `${MARKETING_DOMAIN}/${currentLang}` },
        { '@type': 'ListItem', position: 2, name: t('foundingTrainers.title') },
      ],
    },
  ];

  const benefits = [
    {
      icon: <Gift className="h-8 w-8" />,
      title: t('foundingTrainers.benefit1Title'),
      description: t('foundingTrainers.benefit1Desc'),
    },
    {
      icon: <CreditCard className="h-8 w-8" />,
      title: t('foundingTrainers.benefit2Title'),
      description: t('foundingTrainers.benefit2Desc'),
    },
    {
      icon: <Star className="h-8 w-8" />,
      title: t('foundingTrainers.benefit3Title'),
      description: t('foundingTrainers.benefit3Desc'),
    },
  ];

  const steps = [
    t('foundingTrainers.step1'),
    t('foundingTrainers.step2'),
    t('foundingTrainers.step3'),
    t('foundingTrainers.step4'),
  ];

  const audience = [
    t('foundingTrainers.audience1'),
    t('foundingTrainers.audience2'),
    t('foundingTrainers.audience3'),
    t('foundingTrainers.audience4'),
  ];

  const faqs = [
    { q: t('foundingTrainers.faq1Q'), a: t('foundingTrainers.faq1A') },
    { q: t('foundingTrainers.faq2Q'), a: t('foundingTrainers.faq2A') },
    { q: t('foundingTrainers.faq3Q'), a: t('foundingTrainers.faq3A') },
    { q: t('foundingTrainers.faq4Q'), a: t('foundingTrainers.faq4A') },
    { q: t('foundingTrainers.faq5Q'), a: t('foundingTrainers.faq5A') },
    { q: t('foundingTrainers.faq6Q'), a: t('foundingTrainers.faq6A') },
  ];

  const progressPercent = (SPOTS_CLAIMED / TOTAL_SPOTS) * 100;

  return (
    <MarketingLayout>
      <SEO
        title={t('foundingTrainers.pageTitle')}
        description={t('foundingTrainers.metaDescription')}
        url={`/founding-trainers`}
        structuredData={structuredData}
      />

      {/* Hero */}
      <section className="relative bg-[#1a1a2e] text-white overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-[#0f3460] opacity-90" />
        <div className="relative container mx-auto px-4 py-20 md:py-32 text-center">
          <Badge className="mb-6 bg-primary/20 text-primary border-primary/30 text-sm px-4 py-1.5">
            🏆 {t('foundingTrainers.badge')}
          </Badge>
          <h1 className="text-4xl md:text-6xl font-bold mb-6 tracking-tight">
            {t('foundingTrainers.headline')}
          </h1>
          <p className="text-lg md:text-xl text-gray-300 max-w-2xl mx-auto mb-10">
            {t('foundingTrainers.subheadline')}
          </p>
          <Button asChild size="lg" className="bg-primary hover:bg-primary/90 text-primary-foreground text-lg px-8 py-6 h-auto">
            <Link to={signupUrl}>
              {t('foundingTrainers.cta')} <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </Button>

          {/* Progress bar */}
          <div className="mt-12 max-w-md mx-auto">
            <div className="flex justify-between text-sm text-gray-400 mb-2">
              <span>{SPOTS_CLAIMED} / {TOTAL_SPOTS} {t('foundingTrainers.spotsClaimed')}</span>
              <span>{SPOTS_REMAINING} {t('foundingTrainers.spotsRemaining')}</span>
            </div>
            <div className="h-3 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-700"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* What You Get */}
      <section className="py-20 bg-background">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">{t('foundingTrainers.whatYouGetTitle')}</h2>
          <p className="text-muted-foreground text-center mb-12 max-w-xl mx-auto">{t('foundingTrainers.whatYouGetSub')}</p>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {benefits.map((b, i) => (
              <div key={i} className="rounded-2xl border bg-card p-8 text-center hover:shadow-lg transition-shadow">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-6">
                  {b.icon}
                </div>
                <h3 className="text-xl font-semibold mb-3">{b.title}</h3>
                <p className="text-muted-foreground">{b.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 bg-muted">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">{t('foundingTrainers.howItWorksTitle')}</h2>
          <div className="grid md:grid-cols-4 gap-8 max-w-4xl mx-auto">
            {steps.map((step, i) => (
              <div key={i} className="text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary text-primary-foreground font-bold text-lg mb-4">
                  {i + 1}
                </div>
                <p className="text-sm font-medium">{step}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Value Breakdown */}
      <section className="py-20 bg-background">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">{t('foundingTrainers.valueTitle')}</h2>
          <div className="max-w-lg mx-auto rounded-2xl border bg-card p-8">
            <div className="space-y-4">
              <div className="flex justify-between text-lg">
                <span>{t('foundingTrainers.valueRacket')}</span>
                <span className="font-semibold">€275+</span>
              </div>
              <div className="flex justify-between text-lg">
                <span>{t('foundingTrainers.valuePlan')}</span>
                <span className="font-semibold">€348</span>
              </div>
              <div className="flex justify-between text-lg">
                <span>{t('foundingTrainers.valuePerks')}</span>
                <span className="font-semibold italic">{t('foundingTrainers.priceless')}</span>
              </div>
              <hr className="border-border" />
              <div className="flex justify-between text-xl font-bold">
                <span>{t('foundingTrainers.totalValue')}</span>
                <span>€623+</span>
              </div>
              <div className="flex justify-between text-2xl font-bold text-primary">
                <span>{t('foundingTrainers.youPay')}</span>
                <span>€349</span>
              </div>
            </div>
            <p className="text-center text-muted-foreground mt-6 text-sm">
              {t('foundingTrainers.valueHighlight')}
            </p>
          </div>
        </div>
      </section>

      {/* Who Is This For */}
      <section className="py-20 bg-muted">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">{t('foundingTrainers.whoTitle')}</h2>
          <div className="max-w-2xl mx-auto space-y-4">
            {audience.map((item, i) => (
              <div key={i} className="flex items-start gap-3">
                <CheckCircle className="h-6 w-6 text-primary shrink-0 mt-0.5" />
                <span className="text-lg">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 bg-background">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">{t('foundingTrainers.faqTitle')}</h2>
          <div className="max-w-2xl mx-auto">
            <Accordion type="single" collapsible className="w-full">
              {faqs.map((faq, i) => (
                <AccordionItem key={i} value={`faq-${i}`}>
                  <AccordionTrigger className="text-left text-base">{faq.q}</AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">{faq.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-20 bg-[#1a1a2e] text-white">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">{t('foundingTrainers.finalCtaTitle')}</h2>
          <p className="text-gray-300 mb-8 text-lg">
            {t('foundingTrainers.finalCtaSub', { count: SPOTS_REMAINING })}
          </p>
          <Button asChild size="lg" className="bg-primary hover:bg-primary/90 text-primary-foreground text-lg px-8 py-6 h-auto">
            <Link to={signupUrl}>
              {t('foundingTrainers.finalCtaButton')} <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
          </Button>
        </div>
      </section>
    </MarketingLayout>
  );
}
