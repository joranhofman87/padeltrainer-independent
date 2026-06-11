import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Download, Mail, Globe, Users, MapPin, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';

const FACTS = [
  { label: 'Founded', value: '2024' },
  { label: 'Coverage', value: '6 languages' },
  { label: 'Markets', value: 'Europe-wide' },
  { label: 'Focus', value: 'Padel coaches & academies' },
];

const ASSETS = [
  { name: 'Wordmark — light', file: '/og-image.png', type: 'PNG · 1200×630' },
  { name: 'Wordmark — dark', file: '/og-image.png', type: 'PNG · 1200×630' },
  { name: 'Square avatar', file: '/favicon.ico', type: 'ICO · 32×32' },
];

export default function PressKit() {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'PadelTrainer.ai',
    url: 'https://padeltrainer.ai',
    logo: 'https://padeltrainer.ai/og-image.png',
    sameAs: [],
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'press',
        email: 'press@padeltrainer.ai',
        availableLanguage: ['English', 'Dutch', 'Spanish', 'German', 'French', 'Italian'],
      },
    ],
  };

  return (
    <MarketingLayout>
      <SEO
        title="Press Kit — PadelTrainer.ai"
        description="Official press kit for PadelTrainer.ai. Download high-resolution logos, brand assets, fact sheet, and contact our press team."
        url="/press"
        structuredData={structuredData}
      />

      <div className="container mx-auto px-4 py-12 max-w-5xl">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
          <Badge variant="outline" className="mb-4">Press kit</Badge>
          <h1 className="text-4xl md:text-5xl font-bold mb-4 tracking-tight">
            Press &amp; media resources
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mb-10">
            Everything journalists, partners, and content creators need to write about
            PadelTrainer.ai — logos, brand assets, fact sheet, and a direct line to our team.
          </p>
        </motion.div>

        {/* About */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-3">About PadelTrainer.ai</h2>
          <p className="text-muted-foreground leading-relaxed">
            PadelTrainer.ai is the operating system for padel coaches and academies. It powers
            scheduling, bookings, payments, player management, and a public marketplace where
            players discover trainers, clubs, and lesson programs across Europe. Built for the
            world's fastest-growing racket sport.
          </p>
        </section>

        {/* Fact sheet */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-4">Fact sheet</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {FACTS.map((f) => (
              <Card key={f.label}>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{f.value}</div>
                  <div className="text-sm text-muted-foreground">{f.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Assets */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-4">Brand assets</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {ASSETS.map((a) => (
              <Card key={a.name} className="flex flex-col">
                <CardHeader>
                  <CardTitle className="text-base">{a.name}</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col justify-between gap-3">
                  <div className="aspect-video bg-muted rounded-md flex items-center justify-center overflow-hidden">
                    <img src={a.file} alt={a.name} className="max-h-full max-w-full object-contain" loading="lazy" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{a.type}</span>
                    <Button asChild size="sm" variant="outline" aria-label="Download">
                      <a href={a.file} download>
                        <Download className="h-3.5 w-3.5 mr-1.5" /> Download
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            For vector formats (SVG, AI) or alternate ratios, email{' '}
            <a href="mailto:press@padeltrainer.ai" className="underline">press@padeltrainer.ai</a>.
          </p>
        </section>

        {/* What we cover */}
        <section className="mb-12">
          <h2 className="text-2xl font-semibold mb-4">What PadelTrainer.ai builds</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              { icon: Users, title: 'Coach management', body: 'Scheduling, players, billing, and proposals built specifically for padel coaches.' },
              { icon: MapPin, title: 'Club network', body: 'Public profiles for clubs and academies with lesson programs and trainer rosters.' },
              { icon: Sparkles, title: 'Player tools', body: 'Level tests, racket finder, court reviews, learning hub, and AI-powered video tips.' },
            ].map(({ icon: Icon, title, body }) => (
              <Card key={title}>
                <CardContent className="pt-6">
                  <Icon className="h-6 w-6 text-primary mb-3" />
                  <div className="font-semibold mb-1">{title}</div>
                  <p className="text-sm text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Contact */}
        <section className="mb-12">
          <Card>
            <CardContent className="pt-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold mb-1 flex items-center gap-2">
                  <Mail className="h-5 w-5" /> Press contact
                </h2>
                <p className="text-muted-foreground">
                  Email <a href="mailto:press@padeltrainer.ai" className="underline">press@padeltrainer.ai</a> for interviews, quotes, data, or product walkthroughs.
                </p>
              </div>
              <div className="flex gap-2">
                <Button asChild variant="outline" aria-label="Email press team">
                  <a href="mailto:press@padeltrainer.ai">Email press team</a>
                </Button>
                <Button asChild aria-label="Learn more">
                  <LocalizedLink to="/about">
                    <Globe className="h-4 w-4 mr-2" /> Learn more
                  </LocalizedLink>
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </MarketingLayout>
  );
}
