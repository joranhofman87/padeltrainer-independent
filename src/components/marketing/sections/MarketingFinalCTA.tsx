import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';

interface MarketingFinalCTAProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  primaryHref?: string;
  primaryLabel?: React.ReactNode;
  /** When primaryHref is external (mailto:, http) renders <a> instead of Link */
  primaryExternal?: boolean;
  microcopy?: React.ReactNode;
  secondary?: React.ReactNode;
}

/**
 * Dark navy final CTA band - mirrors the homepage FinalCTASection.
 * Reusable on every marketing page for a consistent close.
 */
export function MarketingFinalCTA({
  eyebrow,
  title,
  body,
  primaryHref,
  primaryLabel,
  primaryExternal = false,
  microcopy,
  secondary,
}: MarketingFinalCTAProps) {
  const { t } = useTranslation('marketing');
  const href = primaryHref ?? getAppUrl('/signup/trainer');
  const label = primaryLabel ?? t('homev2.cta.startTrial');

  const PrimaryButton = primaryExternal ? (
    <a href={href} className="pill-primary text-base">
      {label}
      <ArrowRight className="ml-2 h-5 w-5" />
    </a>
  ) : (
    <Link to={href} className="pill-primary text-base">
      {label}
      <ArrowRight className="ml-2 h-5 w-5" />
    </Link>
  );

  return (
    <section className="py-16 md:py-24 lg:py-32 bg-navy-950 text-white relative overflow-hidden">
      <div className="absolute inset-0 dot-grid opacity-20" aria-hidden />
      <div className="relative max-w-7xl mx-auto px-4 md:px-6 text-center">
        <div className="max-w-3xl mx-auto">
          {eyebrow && (
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 ring-1 ring-white/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-white/80">
              {eyebrow}
            </span>
          )}
          <h2 className="mt-5 font-display text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-[-0.02em] leading-[1.05]">
            {title}
          </h2>
          {body && <p className="mt-6 text-lg text-white/70 leading-relaxed max-w-2xl mx-auto">{body}</p>}
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            {PrimaryButton}
            {secondary}
          </div>
          {microcopy && <p className="mt-4 text-sm text-white/50">{microcopy}</p>}
        </div>
      </div>
    </section>
  );
}
