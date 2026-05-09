import { Link } from 'react-router-dom';
import { ArrowRight, CreditCard, Star, Check, Bell, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { trackEvent } from '@/lib/tracking';

function GoogleCalendarLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#dadce0" />
      <path d="M3 8h18" stroke="#dadce0" strokeWidth="1" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Inter, system-ui" fontSize="9" fontWeight="700" fill="#1a73e8">31</text>
    </svg>
  );
}

export function HeroSection() {
  const { t } = useTranslation('marketing');

  return (
    <section className="relative overflow-hidden">
      {/* Backdrop dot grid */}
      <div className="absolute inset-0 dot-grid opacity-60 -z-10" aria-hidden />

      <div className="relative max-w-7xl mx-auto px-4 md:px-6 pt-10 pb-12 md:pt-16 md:pb-20 lg:pt-24 lg:pb-28 grid lg:grid-cols-12 gap-8 lg:gap-12 items-center overflow-hidden">
        {/* LEFT: copy */}
        <div className="lg:col-span-7 min-w-0">
          <h1 className="sr-only">{t('homev2.hero.h1')}</h1>
          <span aria-hidden className="inline-flex items-center gap-2 rounded-full bg-card border border-navy-900/10 shadow-soft px-3 py-1.5 text-xs font-medium text-navy-700">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
            {t('homev2.hero.eyebrow', 'For padel coaches, academies & clubs')}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-card border border-navy-900/10 shadow-soft px-3 py-1.5 text-xs font-medium text-navy-700">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
            {t('homev2.hero.eyebrow', 'For padel coaches, academies & clubs')}
          </span>

          <h1 className="mt-4 md:mt-6 font-display font-extrabold text-[34px] sm:text-5xl lg:text-7xl leading-[1.05] sm:leading-[1.02] tracking-[-0.02em] text-navy-900">
            {t('homev2.hero.h1')}
          </h1>

          <p className="mt-4 md:mt-6 text-base sm:text-lg md:text-xl text-navy-700 max-w-xl leading-relaxed">
            {t('homev2.hero.subheadline')}
          </p>

          <div className="mt-6 md:mt-8 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3">
            <Link
              to={getAppUrl('/signup/trainer')}
              onClick={() => trackEvent('cta_clicked', { location: 'hero' })}
              className="pill-primary text-base w-full sm:w-auto justify-center"
            >
              {t('homev2.cta.startTrial')}
              <ArrowRight className="ml-2 h-5 w-5" />
            </Link>
            <a href="#how-it-works" className="pill-ghost text-base w-full sm:w-auto justify-center">
              {t('homev2.cta.watchDemo')}
            </a>
          </div>

          <div className="mt-5 md:mt-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:gap-x-5 sm:gap-y-2 text-xs sm:text-sm text-navy-600">
            {[
              t('homev2.cta.trust_nocard', 'No credit card'),
              t('homev2.cta.trust_setup', 'Set up in 10 minutes'),
              t('homev2.cta.trust_gdpr', 'GDPR-ready'),
            ].map((label) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-brand-500" />
                {label}
              </span>
            ))}
          </div>

          <div className="mt-5 md:mt-6 flex items-center gap-2.5">
            <div className="flex items-center gap-0.5 text-brand-500">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className="w-4 h-4 sm:w-5 sm:h-5 fill-current" />
              ))}
            </div>
            <span className="text-xs sm:text-sm text-navy-700">
              <span className="font-semibold text-navy-900">{t('homev2.hero.loved_lead', 'Loved by padel coaches')}</span>{' '}
              <span className="hidden sm:inline">{t('homev2.hero.loved_tail', 'across Europe')}</span>
            </span>
          </div>
        </div>

        {/* RIGHT: mock window + floating chips */}
        <div className="lg:col-span-5 relative">
          <div className="mock-window relative">
            {/* Browser bar */}
            <div className="mock-bar flex items-center px-3 sm:px-4 h-9 gap-1.5">
              <span className="mock-dot bg-red-300" />
              <span className="mock-dot bg-yellow-300" />
              <span className="mock-dot bg-green-300" />
              <span className="ml-3 text-[11px] sm:text-xs text-navy-500 font-medium truncate max-w-[60%]">padeltrainer.ai/rene</span>
            </div>

            {/* Tabs */}
            <div className="px-3 sm:px-4 pt-3 sm:pt-4">
              <div className="flex gap-1 text-[11px] sm:text-xs font-medium overflow-x-auto no-scrollbar">
                <span className="px-2.5 py-1.5 rounded-lg bg-brand-50 text-brand-700 whitespace-nowrap">{t('homev2.hero.tab_booking')}</span>
                <span className="px-2.5 py-1.5 rounded-lg text-navy-500 whitespace-nowrap">{t('homev2.hero.tab_players')}</span>
                <span className="px-2.5 py-1.5 rounded-lg text-navy-500 whitespace-nowrap">{t('homev2.hero.tab_payments')}</span>
                <span className="hidden sm:inline px-2.5 py-1.5 rounded-lg text-navy-500 whitespace-nowrap">{t('homev2.hero.tab_profile')}</span>
              </div>
            </div>

            {/* Slot rows */}
            <div className="px-3 sm:px-4 py-3 sm:py-4 space-y-2">
              <div className="text-[11px] sm:text-xs font-semibold text-navy-500 uppercase tracking-wide">
                {t('homev2.hero.mock_today', 'Today · Tuesday')}
              </div>

              <SlotRow time="07:30" title={t('homev2.hero.mock_row1', 'Group · 2/4')} sub="Court 2 · 60 min" status="paid" />
              <SlotRow time="09:00" title={t('homev2.hero.mock_row2', 'Private · Daan v.')} sub="Court 1 · 45 min" status="confirmed" />
              <SlotRow time="10:30" title={t('homev2.hero.mock_row3', 'Available')} sub="Court 3 · 60 min" status="open" />
              <SlotRow time="12:00" title={t('homev2.hero.mock_row4', 'Group · 4/4 · Sold out')} sub="Court 2 · 60 min" status="paid" />

              <div className="flex items-center gap-2 px-3 py-2 mt-2 rounded-lg bg-navy-50 text-[11px] sm:text-xs text-navy-600">
                <GoogleCalendarLogo className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{t('homev2.hero.mock_booking_sync')}</span>
              </div>
            </div>
          </div>

          {/* Floating chips */}
          <FloatChip
            className="hidden md:flex absolute -left-10 top-10 animate-floaty"
            icon={<Zap className="w-5 h-5" />}
            tone="brand"
            label={t('homev2.hero.chip_cancel_label', 'Cancellation')}
            value={t('homev2.hero.chip_cancel_value', 'Slot refilled fast')}
          />
          <FloatChip
            className="hidden md:flex absolute -right-6 top-1/2 animate-floaty [animation-delay:1.2s]"
            icon={<CreditCard className="w-5 h-5" />}
            tone="navy"
            label={t('homev2.hero.chip_pay_label', 'iDEAL paid')}
            value={t('homev2.hero.chip_pay_value', 'Before the lesson')}
          />
          <FloatChip
            className="hidden md:flex absolute -bottom-6 left-1/4 animate-floaty [animation-delay:2.4s]"
            icon={<Bell className="w-5 h-5" />}
            tone="navy"
            label={t('homev2.hero.chip_notify_label', 'Followers notified')}
            value={t('homev2.hero.chip_notify_value', 'Auto-DM')}
          />
        </div>
      </div>
    </section>
  );
}

function SlotRow({
  time,
  title,
  sub,
  status,
}: {
  time: string;
  title: string;
  sub: string;
  status: 'paid' | 'confirmed' | 'open';
}) {
  const isOpen = status === 'open';
  return (
    <div
      className={`flex items-center justify-between p-2.5 sm:p-3 rounded-xl border ${
        isOpen
          ? 'bg-card border-dashed border-brand-300'
          : status === 'paid'
            ? 'bg-navy-50/60 border-navy-100'
            : 'bg-card border-navy-100'
      }`}
    >
      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <div className="text-[11px] sm:text-xs font-semibold text-navy-700 w-10 sm:w-12 tabular-nums flex-shrink-0">{time}</div>
        <div className="min-w-0">
          <div className={`text-[13px] sm:text-sm font-semibold truncate ${isOpen ? 'text-brand-700' : 'text-navy-900'}`}>{title}</div>
          <div className="text-[11px] sm:text-xs text-navy-500 truncate"><span className="hidden sm:inline">{sub}</span><span className="sm:hidden">{sub.split(' · ')[1] || sub}</span></div>
        </div>
      </div>
      {status === 'paid' && (
        <span className="text-[10px] sm:text-xs font-medium text-success bg-success-soft px-2 py-1 rounded-full flex-shrink-0">Paid</span>
      )}
      {status === 'confirmed' && (
        <span className="text-[10px] sm:text-xs font-medium text-brand-700 bg-brand-50 px-2 py-1 rounded-full flex-shrink-0">Confirmed</span>
      )}
      {status === 'open' && (
        <span className="text-[10px] sm:text-xs font-medium text-navy-500 flex-shrink-0">Auto-fill on</span>
      )}
    </div>
  );
}

function FloatChip({
  icon,
  tone,
  label,
  value,
  className = '',
}: {
  icon: React.ReactNode;
  tone: 'brand' | 'navy';
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`card-chip p-3 items-center gap-3 ${className}`}>
      <div
        className={`w-10 h-10 rounded-xl flex items-center justify-center ${
          tone === 'brand' ? 'bg-brand-50 text-brand-600' : 'bg-navy-50 text-navy-700'
        }`}
      >
        {icon}
      </div>
      <div>
        <div className="text-xs text-navy-500">{label}</div>
        <div className="text-sm font-semibold text-navy-900">{value}</div>
      </div>
    </div>
  );
}
