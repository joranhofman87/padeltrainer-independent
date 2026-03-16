import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Play, Calendar, CreditCard, UserPlus, User, Check, Star, MapPin, Clock } from 'lucide-react';
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
        <div className="h-4 w-4 rounded bg-[hsl(var(--brand-gold))] flex items-center justify-center">
          <Calendar className="h-2.5 w-2.5 text-foreground" />
        </div>
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
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Name</label>
          <div className="h-9 rounded-md border border-input bg-background px-3 flex items-center text-sm text-muted-foreground">Sarah van Dijk</div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Email</label>
          <div className="h-9 rounded-md border border-input bg-background px-3 flex items-center text-sm text-muted-foreground">sarah@email.com</div>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t('homev2.hero.mock_reg_level')}</label>
          <div className="flex gap-2">
            {['Beginner', 'Intermediate', 'Advanced'].map((level, i) => (
              <div key={level} className={`flex-1 text-center text-xs py-2 rounded-md border cursor-default ${i === 1 ? 'bg-primary text-primary-foreground border-primary' : 'border-input bg-background text-muted-foreground'}`}>
                {level}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="h-9 rounded-md bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
        <Check className="h-4 w-4 mr-1.5" />
        {t('homev2.hero.mock_reg_cta')}
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
        <div className="h-4 px-1.5 rounded bg-[hsl(0,0%,15%)] flex items-center justify-center">
          <span className="text-[10px] text-white font-bold tracking-tight">mollie</span>
        </div>
        <span>{t('homev2.hero.mock_payments_powered')}</span>
      </div>
    </div>
  );
}

function MockProfile({ t }: { t: (k: string) => string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4">
        <div className="h-14 w-14 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
          <User className="h-7 w-7 text-primary" />
        </div>
        <div className="min-w-0">
          <h4 className="font-semibold text-sm">Coach Maria Santos</h4>
          <div className="flex items-center gap-1 mt-0.5">
            {[1, 2, 3, 4, 5].map(i => (
              <Star key={i} className={`h-3 w-3 ${i <= 4 ? 'fill-[hsl(var(--brand-gold))] text-[hsl(var(--brand-gold))]' : 'text-border'}`} />
            ))}
            <span className="text-xs text-muted-foreground ml-1">4.8 (32)</span>
          </div>
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>Amsterdam</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {['Mon 09:00', 'Tue 14:00', 'Wed 10:30', 'Thu 16:00'].map(slot => (
          <div key={slot} className="flex items-center gap-1.5 text-xs p-2 rounded-md border border-dashed border-primary/40 bg-primary/5">
            <Clock className="h-3 w-3 text-primary" />
            <span>{slot}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-primary font-medium">{t('homev2.hero.mock_profile_slots', { count: '12' })}</span>
        <div className="h-8 px-4 rounded-md bg-primary text-primary-foreground flex items-center text-xs font-medium">
          {t('homev2.hero.mock_profile_cta')}
        </div>
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

          {/* Mock screen container */}
          <div className="relative rounded-xl rounded-tl-none border-2 border-border bg-card shadow-2xl overflow-hidden">
            {/* Browser chrome */}
            <div className="bg-muted/50 px-4 py-3 border-b flex items-center gap-2">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-destructive/40" />
                <div className="h-3 w-3 rounded-full bg-primary/40" />
                <div className="h-3 w-3 rounded-full bg-green-500/40" />
              </div>
              <span className="text-xs text-muted-foreground ml-2">padeltrainer.ai</span>
            </div>

            {/* Crossfade screens */}
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
