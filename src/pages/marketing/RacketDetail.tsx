import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ExternalLink, ArrowLeft, Check, X as XIcon, Target } from 'lucide-react';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Breadcrumbs } from '@/components/sanity/Breadcrumbs';
import { PortableTextRenderer } from '@/components/sanity/PortableTextRenderer';
import { sanityClient, RACKET_BY_SLUG_QUERY, RELATED_RACKETS_QUERY } from '@/lib/sanity';
import { RacketImage } from '@/components/gear/RacketImage';
import { RacketCard } from '@/components/gear/RacketCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LocalizedLink } from '@/components/LocalizedLink';
import { trackEvent } from '@/lib/tracking';
import { useEffect } from 'react';

const LEVEL_COLORS: Record<string, string> = {
  beginner: 'bg-emerald-100 text-emerald-800',
  intermediate: 'bg-blue-100 text-blue-800',
  advanced: 'bg-purple-100 text-purple-800',
};

const STYLE_COLORS: Record<string, string> = {
  control: 'bg-teal-100 text-teal-800',
  allround: 'bg-amber-100 text-amber-800',
  power: 'bg-red-100 text-red-800',
};

const SPEC_ICONS: Record<string, string> = {
  weight: '⚖️',
  shape: '🔵',
  core: '🧱',
  face: '🪨',
  balance: '⚡',
};

function parseSpecs(specs?: string) {
  if (!specs) return [];
  return specs.split(' | ').map(s => {
    const idx = s.indexOf(': ');
    if (idx === -1) return { label: s, value: '' };
    return { label: s.slice(0, idx).trim(), value: s.slice(idx + 2).trim() };
  });
}

function parsePriceRange(priceRange?: string): { low?: string; high?: string } {
  if (!priceRange) return {};
  const match = priceRange.match(/€?\s*(\d+)\s*[–-]\s*€?\s*(\d+)/);
  if (!match) return {};
  return { low: match[1], high: match[2] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface RacketDetailData {
  _id: string;
  name: string;
  slug: string;
  brand: string;
  level: string;
  priceRange: string;
  priceMidpoint: number;
  shape: string;
  playingStyle: string;
  weight: string;
  armFriendly: boolean;
  shortDescription: string;
  specs: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  description?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image?: any;
  affiliateUrl?: string;
  shop?: string;
  isAvailable?: boolean;
  seo?: { titleTag?: string; metaDescription?: string; breadcrumbLabel?: string };
  language?: string;
  translationOf?: { _ref: string };
  manualRelated?: RelatedRacket[];
}

interface RelatedRacket {
  _id: string;
  name: string;
  slug: string;
  brand: string;
  priceRange: string;
  shortDescription: string;
  shape: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image?: any;
  level: string;
  playingStyle: string;
}

export default function RacketDetail() {
  const { slug, lang = 'en' } = useParams<{ slug: string; lang: string }>();
  const { t } = useTranslation('marketing');

  const { data: racket, isLoading } = useQuery({
    queryKey: ['racket', slug, lang],
    queryFn: () => sanityClient.fetch<RacketDetailData>(RACKET_BY_SLUG_QUERY, { slug, lang }),
    enabled: !!slug,
    staleTime: 1000 * 60 * 10,
  });

  const needsAutoRelated = !racket?.manualRelated?.length;

  const { data: autoRelated = [] } = useQuery({
    queryKey: ['racket-related', slug, lang, racket?.playingStyle, racket?.level],
    queryFn: () => sanityClient.fetch<RelatedRacket[]>(RELATED_RACKETS_QUERY, {
      slug, lang, playingStyle: racket!.playingStyle, level: racket!.level,
    }),
    enabled: !!racket && needsAutoRelated,
    staleTime: 1000 * 60 * 10,
  });

  const related = racket?.manualRelated?.length ? racket.manualRelated : autoRelated;

  useEffect(() => {
    if (racket) {
      trackEvent('product_viewed', { product_name: racket.name, brand: racket.brand, level: racket.level });
    }
  }, [racket]);

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="mx-auto max-w-5xl px-4 py-12">
          <Skeleton className="mb-4 h-8 w-64" />
          <div className="grid gap-8 md:grid-cols-2">
            <Skeleton className="aspect-square rounded-xl" />
            <div className="space-y-4">
              <Skeleton className="h-10 w-3/4" />
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </div>
      </MarketingLayout>
    );
  }

  if (!racket) {
    return (
      <MarketingLayout>
        <div className="flex min-h-[50vh] items-center justify-center">
          <p className="text-muted-foreground">{t('gear.detail.notFound', 'Racket not found.')}</p>
        </div>
      </MarketingLayout>
    );
  }

  const seoTitle = racket.seo?.titleTag || `${racket.name} — ${racket.brand}`;
  const seoDesc = racket.seo?.metaDescription || racket.shortDescription || '';
  const breadcrumbLabel = racket.seo?.breadcrumbLabel || racket.name;
  const specItems = parseSpecs(racket.specs);
  const prices = parsePriceRange(racket.priceRange);

  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: racket.name,
    description: racket.shortDescription,
    brand: { '@type': 'Brand', name: racket.brand },
    category: 'Padel Racket',
    ...(prices.low && prices.high ? {
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'EUR',
        lowPrice: prices.low,
        highPrice: prices.high,
      },
    } : {}),
  };

  const breadcrumbs = [
    { label: t('gear.breadcrumb.home', 'Home'), href: '/' },
    { label: t('gear.breadcrumb.rackets', 'Rackets'), href: '/gear/rackets' },
    { label: breadcrumbLabel },
  ];

  return (
    <MarketingLayout>
      <SEO title={seoTitle} description={seoDesc} url={`/${lang}/gear/rackets/${slug}`} structuredData={productJsonLd} />

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Breadcrumbs */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-muted-foreground">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span>/</span>}
              {crumb.href ? (
                <LocalizedLink to={crumb.href} className="hover:text-primary transition-colors">{crumb.label}</LocalizedLink>
              ) : (
                <span className="text-foreground font-medium">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>

        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="grid gap-8 md:grid-cols-2 mb-12"
        >
          <div className="aspect-square overflow-hidden rounded-xl bg-muted">
            <RacketImage
              image={racket.image}
              brand={racket.brand}
              shape={racket.shape}
              name={racket.name}
              className="h-full w-full"
              width={600}
              height={600}
            />
          </div>

          <div className="flex flex-col justify-center gap-4">
            <div>
              <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{racket.brand}</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-foreground leading-[1.1]">{racket.name}</h1>
            </div>

            <div className="flex flex-wrap gap-2">
              {racket.level && (
                <Badge className={LEVEL_COLORS[racket.level]}>{racket.level}</Badge>
              )}
              {racket.playingStyle && (
                <Badge className={STYLE_COLORS[racket.playingStyle]}>{racket.playingStyle}</Badge>
              )}
              {racket.armFriendly && (
                <Badge className="bg-green-100 text-green-800">💪 Arm-friendly</Badge>
              )}
            </div>

            {racket.priceRange && (
              <p className="text-2xl font-semibold text-foreground">{racket.priceRange}</p>
            )}

            {racket.shortDescription && (
              <p className="text-muted-foreground leading-relaxed">{racket.shortDescription}</p>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center mt-2">
              {racket.affiliateUrl ? (
                <a
                  href={racket.affiliateUrl}
                  target="_blank"
                  rel="nofollow noopener sponsored"
                  onClick={() => trackEvent('affiliate_click', { product_name: racket.name, shop: racket.shop || 'retailer' })}
                >
                  <Button size="lg" className="w-full sm:w-auto">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t('gear.detail.buyAt', 'Buy at {{shop}}', { shop: racket.shop || 'retailer' })}
                  </Button>
                </a>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {t('gear.detail.checkLocal', 'Check availability at your local padel shop')}
                </p>
              )}

              <LocalizedLink to={`/racket-finder?level=${racket.level}&style=${racket.playingStyle}`}>
                <Button variant="outline" size="lg" className="w-full sm:w-auto">
                  <Target className="mr-2 h-4 w-4" />
                  {t('gear.detail.takeQuiz', 'Take the Quiz')}
                </Button>
              </LocalizedLink>
            </div>
          </div>
        </motion.div>

        {/* Quick Specs */}
        {specItems.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="mb-12"
          >
            <h2 className="mb-4 text-xl font-bold text-foreground">{t('gear.detail.quickSpecs', 'Quick Specs')}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {specItems.map((s, i) => {
                const iconKey = s.label.toLowerCase();
                return (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                    <span className="text-xl">{SPEC_ICONS[iconKey] || '📋'}</span>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{s.label}</p>
                      <p className="text-sm font-semibold text-foreground">{s.value}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.section>
        )}

        {/* At a Glance */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mb-12"
        >
          <h2 className="mb-4 text-xl font-bold text-foreground">{t('gear.detail.atAGlance', 'At a Glance')}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <GlanceItem label={t('gear.detail.level', 'Level')} value={racket.level} />
            <GlanceItem label={t('gear.detail.style', 'Style')} value={racket.playingStyle} />
            <GlanceItem
              label={t('gear.detail.armFriendlyLabel', 'Arm-friendly')}
              value={racket.armFriendly ? <Check className="h-5 w-5 text-green-600" /> : <XIcon className="h-5 w-5 text-muted-foreground" />}
            />
            <GlanceItem label={t('gear.detail.priceLabel', 'Price')} value={racket.priceRange} />
          </div>
        </motion.section>

        {/* Full Description */}
        {racket.description && racket.description.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="mb-12"
          >
            <h2 className="mb-4 text-xl font-bold text-foreground">{t('gear.detail.fullDescription', 'Full Review')}</h2>
            <PortableTextRenderer content={racket.description} />
          </motion.section>
        )}

        {/* Similar Rackets */}
        {related.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="mb-6 text-xl font-bold text-foreground">{t('gear.detail.similarRackets', 'Similar Rackets')}</h2>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {related.map(r => (
                <RacketCard
                  key={r._id}
                  name={r.name}
                  slug={r.slug}
                  brand={r.brand}
                  level={r.level}
                  playingStyle={r.playingStyle}
                  shape={r.shape}
                  priceRange={r.priceRange}
                  shortDescription={r.shortDescription}
                  image={r.image}
                />
              ))}
            </div>
          </motion.section>
        )}
      </div>
    </MarketingLayout>
  );
}

function GlanceItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-center">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center justify-center text-sm font-semibold text-foreground capitalize">{value}</div>
    </div>
  );
}
