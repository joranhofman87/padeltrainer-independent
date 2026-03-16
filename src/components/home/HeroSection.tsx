import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Play, Calendar, CreditCard, UserPlus, User, Check, Clock, Users, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAppUrl } from '@/lib/domains';
import { trackEvent } from '@/lib/tracking';

const TABS = ['booking', 'registration', 'payments', 'profile'] as const;
type Tab = typeof TABS[number];

const TAB_ICONS: Record<Tab, React.ElementType> = {
  booking: Calendar,
  registration: UserPlus,
  payments: CreditCard,
  profile: User,
};

function GoogleCalendarLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.316 5.684H5.684v12.632h12.632V5.684z" fill="#fff"/>
      <path d="M18.316 24l5.684-5.684h-5.684V24z" fill="#EA4335"/>
      <path d="M24 5.684V0h-5.684l5.684 5.684z" fill="#188038"/>
      <path d="M5.684 18.316V24H0l5.684-5.684z" fill="#1967D2"/>
      <path d="M24 5.684h-5.684v12.632H24V5.684z" fill="#FBBC04"/>
      <path d="M5.684 5.684H0v12.632h5.684V5.684z" fill="#4285F4"/>
      <path d="M5.684 0v5.684h12.632V0H5.684z" fill="#34A853"/>
      <path d="M5.684 24h12.632v-5.684H5.684V24z" fill="#EA4335"/>
      <path d="M0 5.684V0h5.684L0 5.684z" fill="#1967D2"/>
      <path d="M8.5 16.2V15l2.1-1.8c.5-.4.8-.8.8-1.2 0-.5-.3-.8-.9-.8-.5 0-.9.2-1.3.6l-.9-.8c.6-.6 1.3-1 2.3-1 1.3 0 2.1.7 2.1 1.8 0 .7-.4 1.3-1.1 1.9l-1.3 1.1h2.5v1.2H8.5zm6.3 0v-1l1.1-.9c1.1-.9 1.6-1.5 1.6-2.1 0-.5-.3-.8-.9-.8-.5 0-.9.3-1.2.7l-.9-.7c.5-.7 1.2-1.1 2.2-1.1 1.3 0 2.1.8 2.1 1.8 0 .9-.6 1.6-1.5 2.3l-.7.5h2.3v1.2h-4.1z" fill="#4285F4"/>
    </svg>
  );
}

function MollieLogo({ className }: { className?: string }) {
  return (
    <div className={`inline-flex items-center justify-center rounded bg-[hsl(0,0%,15%)] px-2 py-0.5 ${className}`}>
      <span className="text-[11px] text-white font-bold tracking-tight">mollie</span>
    </div>
  );
}

function MockBooking({ t }: { t: (k: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-4">
        <Calendar className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">{t('homev2.hero.mock_booking_title')}</span>
      </div>
      {[
        { time: '09:00', label: 'Private — Ana M.', booked: true },
        { time: '10:30', label: 'Group (4p) — Beginners', booked: true },
        { time: '14:00', label: 'Private — Open', booked: false },
        { time: '16:00', label: 'Group (4p) — Intermediate', booked: false },
      ].map((slot, i) => (
        <div key={i} className={`flex items-center gap-3 p-3 rounded-lg border text-sm ${slot.booked ? 'bg-muted/30 border-border' : 'border-dashed border-primary/50 bg-primary/5'}`}>
          <span className="font-mono text-muted-foreground w-12">{slot.time}</span>
          <span className="flex-1">{slot.label}</span>
          {slot.booked ? (
            <span className="text-xs bg-primary/60 text-primary-foreground px-2 py-0.5 rounded">✓</span>
          ) : (
            <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded">{t('homev2.hero.mock_booking_slot')}</span>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        <GoogleCalendarLogo className="h-4 w-4" />
        <span>{t('homev2.hero.mock_booking_sync')}</span>
      </div>
    </div>
  );
}

function MockRegistration({ t }: { t: (k: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <UserPlus className="h-5 w-5 text-primary" />
        <span className="font-semibold text-sm">{t('homev2.hero.mock_reg_title')}</span>
      </div>

      {/* Stats highlight */}
      <div className="flex items-center gap-4">
        <div className="flex-1 rounded-xl border bg-primary/5 border-primary/20 p-4 text-center">
          <div className="text-3xl font-bold text-primary">52</div>
          <div className="text-xs text-muted-foreground mt-1">{t('homev2.hero.mock_reg_subtitle')}</div>
        </div>
        <div className="flex-1 rounded-xl border bg-muted/30 p-4 text-center">
          <div className="text-3xl font-bold text-foreground">6</div>
          <div className="text-xs text-muted-foreground mt-1">{t('homev2.hero.mock_reg_groups')}</div>
        </div>
      </div>

      {/* Recent registrations */}
      <div className="space-y-2">
        {[
          { name: 'Sarah van Dijk', time: '2 min ago', level: 'Intermediate' },
          { name: 'Marco Visser', time: '8 min ago', level: 'Beginner' },
          { name: 'Lisa de Boer', time: '15 min ago', level: 'Advanced' },
        ].map((reg, i) => (
          <div key={i} className="flex items-center gap-3 text-sm">
            <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Users className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="flex-1 truncate">{reg.name}</span>
            <span className="text-xs text-muted-foreground">{reg.level}</span>
            <span className="text-xs text-muted-foreground">{reg.time}</span>
          </div>
        ))}
      </div>

      {/* AI auto-plan */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <Sparkles className="h-4 w-4 text-primary flex-shrink-0" />
        <span className="text-xs text-primary font-medium">{t('homev2.hero.mock_reg_ai')}</span>
      </div>
    </div>
  );
}

function MockPayments({ t }: { t: (k: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">{t('homev2.hero.mock_payments_title')}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('homev2.hero.mock_payments_auto')}</span>
          <div className="h-5 w-9 rounded-full bg-primary flex items-center px-0.5">
            <div className="h-4 w-4 rounded-full bg-primary-foreground ml-auto" />
          </div>
        </div>
      </div>
      <div className="rounded-lg border overflow-hidden">
        <div className="grid grid-cols-3 gap-0 text-xs font-medium text-muted-foreground bg-muted/50 p-2.5">
          <span>Player</span>
          <span className="text-right">Amount</span>
          <span className="text-right">Status</span>
        </div>
        {[
          { name: 'Ana M.', amount: '€35', status: 'Paid' },
          { name: 'Marco V.', amount: '€25', status: 'Paid' },
          { name: 'Lisa K.', amount: '€35', status: 'Pending' },
          { name: 'Tom B.', amount: '€25', status: 'Paid' },
        ].map((row, i) => (
          <div key={i} className="grid grid-cols-3 gap-0 text-sm p-2.5 border-t">
            <span>{row.name}</span>
            <span className="text-right font-mono">{row.amount}</span>
            <span className="text-right">
              <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${row.status === 'Paid' ? 'bg-green-500/10 text-green-600' : 'bg-primary/10 text-primary'}`}>
                {row.status === 'Paid' && <Check className="h-3 w-3 mr-0.5" />}
                {row.status}
              </span>
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
        <MollieLogo />
        <span>{t('homev2.hero.mock_payments_powered')}</span>
      </div>
    </div>
  );
}

function MockProfile({ t }: { t: (k: string, opts?: Record<string, unknown>) => string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
          <User className="h-6 w-6 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold text-sm">Coach Maria Santos</h4>
          <p className="text-xs text-muted-foreground mt-0.5">padeltrainer.ai/maria-santos</p>
        </div>
        <div className="rounded-lg bg-primary/10 px-3 py-1.5 text-center flex-shrink-0">
          <div className="text-lg font-bold text-primary">8</div>
          <div className="text-[10px] text-primary/80">{t('homev2.hero.mock_profile_slots', { count: '8' })}</div>
        </div>
      </div>

      {/* Open slots grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { day: 'Mon', time: '09:00' },
          { day: 'Mon', time: '14:00' },
          { day: 'Tue', time: '10:30' },
          { day: 'Wed', time: '09:00' },
          { day: 'Wed', time: '16:00' },
          { day: 'Thu', time: '14:00' },
          { day: 'Fri', time: '09:00' },
          { day: 'Fri', time: '11:00' },
        ].map((slot, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs p-2.5 rounded-lg border border-dashed border-primary/40 bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer">
            <Clock className="h-3 w-3 text-primary flex-shrink-0" />
            <span className="font-medium">{slot.day} {slot.time}</span>
          </div>
        ))}
      </div>

      <div className="h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
        {t('homev2.hero.mock_profile_cta')}
      </div>
    </div>
  );
}

export function HeroSection() {
  const { t } = useTranslation('marketing');
  const [activeTab, setActiveTab] = useState<Tab>('booking');

  const mockScreens: Record<Tab, React.ReactNode> = {
    booking: <MockBooking t={t} />,
    registration: <MockRegistration t={t} />,
    payments: <MockPayments t={t} />,
    profile: <MockProfile t={t} />,
  };

  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-secondary/5 pointer-events-none" />
      <div className="absolute top-20 right-10 w-72 h-72 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-20 left-10 w-56 h-56 bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-5xl mx-auto px-4 md:px-6 py-16 md:py-24">
        {/* Centered copy */}
        <div className="text-center animate-fade-in max-w-3xl mx-auto">
          <h1 className="text-4xl md:text-5xl lg:text-7xl font-bold tracking-tight leading-[1.1] mb-6">
            {t('homev2.hero.h1')}
          </h1>

          <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            {t('homev2.hero.subheadline')}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-4">
            <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
              <Link to={getAppUrl('/signup/trainer')} onClick={() => trackEvent('cta_clicked', { location: 'hero' })}>
                {t('homev2.cta.startTrial')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" className="text-lg px-8 h-14 border-2" asChild>
              <a href="#how-it-works">
                <Play className="mr-2 h-4 w-4" />
                {t('homev2.cta.watchDemo')}
              </a>
            </Button>
          </div>

          <p className="text-sm text-muted-foreground mb-12">
            {t('homev2.cta.trustMicrocopy')}
          </p>
        </div>

        {/* Interactive product showcase */}
        <div
          className="animate-fade-in max-w-3xl mx-auto"
          style={{ animationDelay: '200ms', animationFillMode: 'backwards' }}
        >
          {/* Tabs */}
          <div className="flex gap-1 overflow-x-auto pb-1 mb-0 scrollbar-hide justify-center">
            {TABS.map(tab => {
              const Icon = TAB_ICONS[tab];
              const isActive = tab === activeTab;
              return (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab);
                    trackEvent('hero_tab_clicked', { tab });
                  }}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-card text-foreground border border-b-0 border-border shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{t(`homev2.hero.tab_${tab}`)}</span>
                </button>
              );
            })}
          </div>

          {/* Mock screen container — clean card, no browser chrome */}
          <div className="relative rounded-xl rounded-tl-none border-2 border-border bg-card shadow-2xl overflow-hidden">
            <div className="relative min-h-[320px] md:min-h-[340px]">
              {TABS.map(tab => (
                <div
                  key={tab}
                  className={`absolute inset-0 p-5 md:p-6 transition-opacity duration-300 ${
                    tab === activeTab ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'
                  }`}
                >
                  {mockScreens[tab]}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
