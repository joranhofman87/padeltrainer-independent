import { Link } from 'react-router-dom';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { ArrowRight, Check, Sparkles, Star } from 'lucide-react';

const brandShades = [
  { name: 'brand-50', cls: 'bg-brand-50', hsl: '24 100% 96%', text: 'text-navy-900' },
  { name: 'brand-200', cls: 'bg-brand-200', hsl: '28 100% 83%', text: 'text-navy-900' },
  { name: 'brand-300', cls: 'bg-brand-300', hsl: '27 100% 72%', text: 'text-navy-900' },
  { name: 'brand-500', cls: 'bg-brand-500', hsl: '21 95% 53%', text: 'text-white' },
  { name: 'brand-600', cls: 'bg-brand-600', hsl: '22 92% 47%', text: 'text-white' },
  { name: 'brand-700', cls: 'bg-brand-700', hsl: '22 88% 40%', text: 'text-white' },
];

const navyShades = [
  { name: 'navy-50', cls: 'bg-navy-50', hsl: '220 41% 96%', text: 'text-navy-900' },
  { name: 'navy-100', cls: 'bg-navy-100', hsl: '220 27% 90%', text: 'text-navy-900' },
  { name: 'navy-700', cls: 'bg-navy-700', hsl: '218 38% 38%', text: 'text-white' },
  { name: 'navy-900', cls: 'bg-navy-900', hsl: '218 67% 24%', text: 'text-white' },
  { name: 'navy-950', cls: 'bg-navy-950', hsl: '220 70% 14%', text: 'text-white' },
];

function Swatch({ name, cls, hsl, text }: { name: string; cls: string; hsl: string; text: string }) {
  return (
    <div className="card-chip overflow-hidden">
      <div className={`${cls} ${text} h-24 flex items-end p-3 font-display font-bold`}>{name}</div>
      <div className="px-3 py-2 text-xs text-navy-700">
        <div className="font-mono">hsl({hsl})</div>
      </div>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  description,
  children,
  alt,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  alt?: boolean;
}) {
  return (
    <section className={`py-16 md:py-24 ${alt ? 'section-cream' : 'bg-white'}`}>
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="max-w-3xl mb-10 md:mb-14">
          <span className="eyebrow">{eyebrow}</span>
          <h2 className="mt-4 font-display text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {title}
          </h2>
          {description && (
            <p className="mt-4 text-base md:text-lg text-navy-700 leading-relaxed">{description}</p>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

export default function Brand() {
  return (
    <MarketingLayout>
      <SEO
        title="Brand | PadelTrainer.ai"
        description="The PadelTrainer.ai design system: colors, typography, components and voice."
        canonicalUrl="https://padeltrainer.ai/brand"
      />

      {/* HERO */}
      <section className="relative overflow-hidden bg-white">
        <div className="absolute inset-0 dot-grid opacity-60 -z-10" aria-hidden />
        <div className="max-w-7xl mx-auto px-4 md:px-6 pt-16 md:pt-24 pb-12 md:pb-16">
          <span className="eyebrow">Brand</span>
          <h1 className="mt-4 font-display font-extrabold text-[34px] sm:text-5xl lg:text-6xl leading-[1.05] tracking-[-0.02em] text-navy-900 max-w-3xl">
            The PadelTrainer.ai design system.
          </h1>
          <p className="mt-5 text-base md:text-lg text-navy-700 max-w-2xl leading-relaxed">
            Modern, calm, confident. The visual language behind every screen — from the booking page on a player's phone to the trainer dashboard. Use this page as a reference when you build, write or partner with us.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href="#colors" className="pill-primary">
              Explore the system <ArrowRight className="ml-2 h-5 w-5" />
            </a>
            <a
              href="https://github.com/lovable-dev/padeltrainer/blob/main/docs/DESIGN_SYSTEM.md"
              className="pill-ghost"
              target="_blank"
              rel="noreferrer"
            >
              Read the docs
            </a>
          </div>
        </div>
      </section>

      {/* LOGO */}
      <Section
        eyebrow="Logo"
        title="The wordmark"
        description="Use the wordmark on a white or cream surface. On dark backgrounds, switch to the inverted version. Always keep clear space equal to the height of the 'P' around it."
        alt
      >
        <div className="grid md:grid-cols-2 gap-6">
          <div className="card-chip p-10 flex items-center justify-center bg-white">
            <span className="font-display font-extrabold text-3xl md:text-4xl text-navy-900">
              PadelTrainer<span className="text-brand-500">.ai</span>
            </span>
          </div>
          <div className="card-chip p-10 flex items-center justify-center bg-navy-950">
            <span className="font-display font-extrabold text-3xl md:text-4xl text-white">
              PadelTrainer<span className="text-brand-500">.ai</span>
            </span>
          </div>
        </div>
      </Section>

      {/* COLORS */}
      <Section
        eyebrow="Colors"
        title="A warm orange on a calm navy."
        description="Brand orange leads. Navy carries the structure and the words. Cream and off-white create breathing room between sections."
      >
        <div id="colors" className="space-y-10">
          <div>
            <h3 className="font-display font-bold text-xl text-navy-900 mb-4">Brand</h3>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              {brandShades.map((s) => <Swatch key={s.name} {...s} />)}
            </div>
          </div>
          <div>
            <h3 className="font-display font-bold text-xl text-navy-900 mb-4">Navy</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {navyShades.map((s) => <Swatch key={s.name} {...s} />)}
            </div>
          </div>
        </div>
      </Section>

      {/* TYPOGRAPHY */}
      <Section
        eyebrow="Typography"
        title="Plus Jakarta Sans + Inter."
        description="Plus Jakarta Sans for display (h1-h3, hero numerals). Inter for body. Tight tracking on headings, comfortable leading on copy."
        alt
      >
        <div className="grid md:grid-cols-2 gap-6">
          <div className="card-chip p-8">
            <div className="text-xs uppercase tracking-wider text-brand-600 font-semibold mb-4">Display · Plus Jakarta Sans</div>
            <div className="font-display font-extrabold text-5xl text-navy-900 leading-[1.05] tracking-[-0.02em]">
              The all-in-one
            </div>
            <div className="font-display font-bold text-3xl text-navy-900 mt-4">
              Section heading
            </div>
            <div className="font-display font-semibold text-xl text-navy-900 mt-4">
              Card title
            </div>
          </div>
          <div className="card-chip p-8">
            <div className="text-xs uppercase tracking-wider text-brand-600 font-semibold mb-4">Body · Inter</div>
            <p className="text-lg text-navy-700 leading-relaxed">
              Large body. Used for hero subheadlines and high-emphasis paragraphs.
            </p>
            <p className="text-base text-navy-700 leading-relaxed mt-3">
              Default body. Used for descriptions, FAQ answers and most marketing copy.
            </p>
            <p className="text-sm text-navy-600 mt-3">
              Small body. Used for trust badges and meta information.
            </p>
          </div>
        </div>
      </Section>

      {/* COMPONENTS */}
      <Section
        eyebrow="Components"
        title="Primitives in the wild."
        description="Every marketing surface is built from a handful of primitives. Compose, do not invent."
      >
        <div className="grid md:grid-cols-2 gap-6">
          <div className="card-chip p-8 space-y-4">
            <div className="text-xs uppercase tracking-wider text-brand-600 font-semibold">Buttons</div>
            <div className="flex flex-wrap gap-3">
              <button className="pill-primary">
                Primary CTA <ArrowRight className="ml-2 h-5 w-5" />
              </button>
              <button className="pill-ghost">Secondary</button>
            </div>
          </div>

          <div className="card-chip p-8 space-y-3">
            <div className="text-xs uppercase tracking-wider text-brand-600 font-semibold">Eyebrow + heading</div>
            <span className="eyebrow">For padel coaches</span>
            <h3 className="font-display font-extrabold text-3xl text-navy-900 leading-tight">
              Add availability once.
            </h3>
          </div>

          <div className="card-chip p-8">
            <div className="text-xs uppercase tracking-wider text-brand-600 font-semibold mb-4">Card chip</div>
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center flex-shrink-0">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <div className="font-display font-bold text-navy-900">Auto-fill cancellations</div>
                <div className="text-sm text-navy-700 mt-1">
                  Slot reopens to your followers within seconds.
                </div>
              </div>
            </div>
          </div>

          <div className="mock-window">
            <div className="mock-bar flex items-center px-4 h-9 gap-1.5">
              <span className="mock-dot bg-red-300" />
              <span className="mock-dot bg-yellow-300" />
              <span className="mock-dot bg-green-300" />
              <span className="ml-3 text-xs text-navy-500 font-medium">padeltrainer.ai/rene</span>
            </div>
            <div className="p-5">
              <div className="text-xs uppercase tracking-wider text-brand-600 font-semibold mb-3">Mock window</div>
              <div className="flex items-center gap-0.5 text-brand-500">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className="w-4 h-4 fill-current" />
                ))}
              </div>
              <div className="text-sm text-navy-700 mt-2">Used to frame product previews on marketing pages.</div>
            </div>
          </div>
        </div>
      </Section>

      {/* VOICE */}
      <Section
        eyebrow="Voice"
        title="How we sound."
        alt
      >
        <div className="grid md:grid-cols-2 gap-6">
          {[
            ['Concrete over abstract', 'Lead with the outcome, not the feature. "Get paid before the lesson", not "Payment processing".'],
            ['Sentence case in NL', 'Dutch headlines use sentence case. English headlines use title case.'],
            ['No em-dashes', 'Use a regular hyphen with spaces. It reads cleaner across languages.'],
            ['Globally positioned', 'Avoid country and region names in copy. We serve coaches across Europe.'],
          ].map(([title, desc]) => (
            <div key={title} className="card-chip p-6 flex gap-3">
              <Check className="h-5 w-5 text-brand-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-display font-bold text-navy-900">{title}</div>
                <div className="text-sm text-navy-700 mt-1">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* CTA */}
      <section className="py-16 md:py-24 bg-navy-950 text-white relative overflow-hidden">
        <div className="absolute inset-0 dot-grid opacity-20 -z-0" aria-hidden />
        <div className="relative max-w-4xl mx-auto px-4 md:px-6 text-center">
          <h2 className="font-display font-extrabold text-3xl sm:text-4xl md:text-5xl tracking-[-0.02em] leading-tight">
            Building something with PadelTrainer.ai?
          </h2>
          <p className="mt-4 text-white/80 max-w-xl mx-auto">
            Reach out for press, partnerships or asset requests.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <a href="mailto:hello@padeltrainer.ai" className="pill-primary">
              hello@padeltrainer.ai
            </a>
            <Link to="/partner" className="pill-ghost">
              Partner with us
            </Link>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
