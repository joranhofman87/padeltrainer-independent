import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { 
  ArrowRight, 
  Users, 
  Star, 
  MapPin, 
  Calendar,
  Shield,
  TrendingUp,
  CheckCircle2,
  Zap
} from 'lucide-react';

const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5 }
};

const staggerContainer = {
  animate: {
    transition: {
      staggerChildren: 0.1
    }
  }
};

export default function Home() {
  const { t } = useTranslation('marketing');

  const features = [
    {
      icon: Users,
      titleKey: 'home.features.verified.title',
      descriptionKey: 'home.features.verified.description'
    },
    {
      icon: Calendar,
      titleKey: 'home.features.booking.title',
      descriptionKey: 'home.features.booking.description'
    },
    {
      icon: Star,
      titleKey: 'home.features.matching.title',
      descriptionKey: 'home.features.matching.description'
    },
    {
      icon: MapPin,
      titleKey: 'home.features.local.title',
      descriptionKey: 'home.features.local.description'
    },
    {
      icon: Shield,
      titleKey: 'home.features.payments.title',
      descriptionKey: 'home.features.payments.description'
    },
    {
      icon: TrendingUp,
      titleKey: 'home.features.progress.title',
      descriptionKey: 'home.features.progress.description'
    }
  ];

  const stats = [
    { value: '500+', labelKey: 'home.stats.trainers' },
    { value: '10,000+', labelKey: 'home.stats.lessons' },
    { value: '4.9', labelKey: 'home.stats.rating' },
    { value: '50+', labelKey: 'home.stats.cities' }
  ];

  const testimonials = [
    {
      nameKey: 'home.testimonials.items.1.name',
      roleKey: 'home.testimonials.items.1.role',
      contentKey: 'home.testimonials.items.1.content',
      rating: 5
    },
    {
      nameKey: 'home.testimonials.items.2.name',
      roleKey: 'home.testimonials.items.2.role',
      contentKey: 'home.testimonials.items.2.content',
      rating: 5
    },
    {
      nameKey: 'home.testimonials.items.3.name',
      roleKey: 'home.testimonials.items.3.role',
      contentKey: 'home.testimonials.items.3.content',
      rating: 5
    }
  ];

  const steps = [
    { step: '1', titleKey: 'home.howItWorks.step1.title', descriptionKey: 'home.howItWorks.step1.description' },
    { step: '2', titleKey: 'home.howItWorks.step2.title', descriptionKey: 'home.howItWorks.step2.description' },
    { step: '3', titleKey: 'home.howItWorks.step3.title', descriptionKey: 'home.howItWorks.step3.description' }
  ];

  const websiteStructuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "PadelTrainer.ai",
    "url": "https://padeltrainer.ai",
    "description": t('home.hero.subtitle'),
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
        title={t('home.hero.title')}
        description={t('home.hero.subtitle')}
        url="/"
        structuredData={[websiteStructuredData, organizationStructuredData]}
      />
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-accent/5" />
        <div className="absolute top-20 right-10 w-72 h-72 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-10 left-10 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
        
        <div className="container relative mx-auto px-4 py-20 md:py-32">
          <motion.div 
            className="text-center max-w-4xl mx-auto"
            initial="initial"
            animate="animate"
            variants={staggerContainer}
          >
            <motion.div variants={fadeInUp}>
              <Badge variant="secondary" className="mb-6 px-4 py-1.5 text-sm">
                <Zap className="h-3.5 w-3.5 mr-1.5" />
                {t('home.badge')}
              </Badge>
            </motion.div>
            
            <motion.h1 
              variants={fadeInUp}
              className="text-4xl md:text-6xl lg:text-7xl font-bold mb-6 tracking-tight"
            >
              {t('home.hero.title')}
              <span className="block bg-gradient-to-r from-primary to-[hsl(var(--brand-gold))] bg-clip-text text-transparent">
                {t('home.hero.titleHighlight')}
              </span>
            </motion.h1>
            
            <motion.p 
              variants={fadeInUp}
              className="text-xl md:text-2xl text-muted-foreground mb-10 max-w-2xl mx-auto"
            >
              {t('home.hero.subtitle')}
            </motion.p>
            
            <motion.div 
              variants={fadeInUp}
              className="flex flex-col sm:flex-row gap-4 justify-center"
            >
              <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
                <Link to="/signup/player">
                  {t('home.hero.cta')}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="text-lg px-8 h-14 border-2" asChild>
                <Link to="/signup/trainer">{t('home.hero.ctaSecondary')}</Link>
              </Button>
            </motion.div>

            {/* Trust indicators */}
            <motion.div 
              variants={fadeInUp}
              className="mt-12 flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>{t('home.trust.freeToJoin')}</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>{t('home.trust.knltbVerified')}</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>{t('home.trust.securePayments')}</span>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="border-y bg-accent/30">
        <div className="container mx-auto px-4 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat, index) => (
              <motion.div
                key={stat.labelKey}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="text-center"
              >
                <div className="text-3xl md:text-4xl font-bold text-primary mb-1">
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground">{t(stat.labelKey)}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('home.features.title')}
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('home.features.subtitle')}
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, index) => (
              <motion.div
                key={feature.titleKey}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="h-full hover:shadow-lg transition-shadow border-2 hover:border-primary/20">
                  <CardContent className="p-6">
                    <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                      <feature.icon className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">{t(feature.titleKey)}</h3>
                    <p className="text-muted-foreground">{t(feature.descriptionKey)}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section className="py-20 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">{t('home.howItWorks.title')}</h2>
            <p className="text-lg text-muted-foreground">{t('home.howItWorks.subtitle')}</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {steps.map((item, index) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.15 }}
                className="text-center"
              >
                <div className="h-16 w-16 rounded-full bg-primary text-primary-foreground text-2xl font-bold flex items-center justify-center mx-auto mb-4">
                  {item.step}
                </div>
                <h3 className="text-xl font-semibold mb-2">{t(item.titleKey)}</h3>
                <p className="text-muted-foreground">{t(item.descriptionKey)}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">{t('home.testimonials.title')}</h2>
            <p className="text-lg text-muted-foreground">{t('home.testimonials.subtitle')}</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6">
            {testimonials.map((testimonial, index) => (
              <motion.div
                key={testimonial.nameKey}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="h-full">
                  <CardContent className="p-6">
                    <div className="flex gap-1 mb-4">
                      {Array.from({ length: testimonial.rating }).map((_, i) => (
                        <Star key={i} className="h-4 w-4 fill-primary text-primary" />
                      ))}
                    </div>
                    <p className="text-muted-foreground mb-4">"{t(testimonial.contentKey)}"</p>
                    <div>
                      <div className="font-semibold">{t(testimonial.nameKey)}</div>
                      <div className="text-sm text-muted-foreground">{t(testimonial.roleKey)}</div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-accent text-accent-foreground">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center max-w-2xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {t('home.cta.title')}
            </h2>
            <p className="text-lg text-accent-foreground/80 mb-8">
              {t('home.cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
                <Link to="/signup/player">
                  {t('home.cta.button')}
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" className="text-lg px-8 h-14" asChild>
                <Link to="/trainers">{t('home.cta.browseTrainers')}</Link>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
