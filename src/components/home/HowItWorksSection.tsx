import { useTranslation } from 'react-i18next';
import { Check, RefreshCw, Copy } from 'lucide-react';

const heatLevels = [
  'bg-brand-50',
  'bg-brand-200/70',
  'bg-brand-50',
  'bg-brand-300',
  'bg-brand-200/70',
  'bg-brand-500',
  'bg-brand-50',
];
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function AvailabilityMock() {
  return (
    <div className="mock-window p-5 md:p-6">
      <div className="flex items-center gap-2 text-xs text-navy-700/70 mb-5">
        <span className="mock-dot bg-[#ff5f57]" />
        <span className="mock-dot bg-[#febc2e]" />
        <span className="mock-dot bg-[#28c840]" />
        <span className="ml-3">Setup · Step 1 of 4</span>
      </div>
      <div className="text-[11px] font-semibold tracking-[0.14em] text-navy-900 mb-3">
        WEEKLY AVAILABILITY
      </div>
      <div className="grid grid-cols-7 gap-2 md:gap-3">
        {days.map((d, i) => (
          <div key={d} className="flex flex-col items-center gap-2">
            <span className="text-[11px] md:text-xs font-medium text-navy-700/80">{d}</span>
            <div className={`w-full aspect-square rounded-lg ${heatLevels[i]}`} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 mt-5">
        <div className="rounded-xl border border-navy-900/10 px-4 py-3">
          <div className="text-[11px] text-navy-700/70">Group size</div>
          <div className="font-display font-bold text-navy-900">2 – 4 players</div>
        </div>
        <div className="rounded-xl border border-navy-900/10 px-4 py-3">
          <div className="text-[11px] text-navy-700/70">Per player</div>
          <div className="font-display font-bold text-navy-900">€18 / 60 min</div>
        </div>
      </div>
    </div>
  );
}

function BookingPageMock() {
  return (
    <div className="mock-window p-5 md:p-6">
      <div className="flex items-center gap-2 text-xs text-navy-700/70 mb-5">
        <span className="mock-dot bg-[#ff5f57]" />
        <span className="mock-dot bg-[#febc2e]" />
        <span className="mock-dot bg-[#28c840]" />
        <span className="ml-3">Your booking page</span>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-xl bg-navy-50/60 border border-navy-900/5 px-4 py-2.5 text-sm">
        <span className="text-navy-700/80 truncate">
          padeltrainer.ai/<span className="text-brand-600 font-semibold">your-name</span>
        </span>
        <button className="inline-flex items-center gap-1 text-xs font-semibold text-navy-900 px-2.5 py-1 rounded-md border border-navy-900/10 bg-white">
          <Copy className="h-3 w-3" /> Copy
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-4">
        {[
          ['Instagram', 'Bio link'],
          ['WhatsApp', 'Status'],
          ['QR', 'On-court'],
        ].map(([a, b]) => (
          <div key={a} className="rounded-xl border border-navy-900/10 px-3 py-2 text-center">
            <div className="text-xs font-semibold text-navy-900">{a}</div>
            <div className="text-[11px] text-navy-700/70">{b}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-navy-900/10 p-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-brand-50 text-brand-700 flex items-center justify-center font-display font-bold text-xs">
            RL
          </div>
          <div>
            <div className="font-semibold text-navy-900 text-sm">René Lindenbergh</div>
            <div className="text-[11px] text-navy-700/70">Founder · RL Padel Performance</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3">
          {['Tue 18:00', 'Wed 09:00', 'Sat 11:00'].map((s) => (
            <div key={s} className="rounded-lg bg-brand-50 text-brand-700 text-xs font-semibold py-2 text-center">
              {s}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const calendarSlots: Array<Array<{ time: string; label: string; tone: 'orange' | 'navy' }>> = [
  [
    { time: '07:30', label: 'Group', tone: 'orange' },
    { time: '12:00', label: 'Lunch', tone: 'navy' },
  ],
  [
    { time: '09:00', label: 'Daan', tone: 'orange' },
    { time: '18:00', label: 'Group', tone: 'orange' },
  ],
  [
    { time: '10:00', label: 'Vet', tone: 'navy' },
    { time: '19:00', label: 'Group', tone: 'orange' },
  ],
  [
    { time: '08:00', label: 'Private', tone: 'orange' },
    { time: '17:30', label: 'Group', tone: 'orange' },
  ],
  [
    { time: '07:30', label: 'Group', tone: 'orange' },
    { time: '19:00', label: 'Family', tone: 'navy' },
  ],
];
const weekShort = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

function CalendarMock() {
  return (
    <div className="mock-window p-5 md:p-6">
      <div className="flex items-center gap-2 text-xs text-navy-700/70 mb-5">
        <span className="mock-dot bg-[#ff5f57]" />
        <span className="mock-dot bg-[#febc2e]" />
        <span className="mock-dot bg-[#28c840]" />
        <span className="ml-3">Calendar · synced</span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {weekShort.map((d, idx) => (
          <div key={d} className="flex flex-col gap-2">
            <div className="text-[11px] font-semibold tracking-wider text-navy-900 text-center">
              {d}
            </div>
            {calendarSlots[idx].map((slot, i) => (
              <div
                key={i}
                className={`rounded-lg px-2 py-2 text-[11px] leading-tight ${
                  slot.tone === 'orange'
                    ? 'bg-brand-50 text-brand-700'
                    : 'bg-navy-50 text-navy-900'
                }`}
              >
                <div className="font-semibold">{slot.time}</div>
                <div className="opacity-90">{slot.label}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-2 rounded-xl bg-navy-50/60 px-3 py-2.5 text-xs text-navy-900">
        <RefreshCw className="h-3.5 w-3.5 text-brand-600" />
        Last sync · 28 sec ago
      </div>
    </div>
  );
}

const steps = [
  {
    num: '1',
    eyebrowKey: 'step1_eyebrow',
    eyebrowFallback: 'Set up',
    titleKey: 'step1_title',
    descKey: 'step1_desc',
    bullets: ['step1_bullet1', 'step1_bullet2'],
    bulletFallbacks: ['Per-court, per-group pricing', 'Recurring weekly schedule'],
    Visual: AvailabilityMock,
    reverse: false,
  },
  {
    num: '2',
    eyebrowKey: 'step2_eyebrow',
    eyebrowFallback: 'Share',
    titleKey: 'step2_title',
    descKey: 'step2_desc',
    bullets: ['step2_bullet1', 'step2_bullet2'],
    bulletFallbacks: ['Mobile-first booking page', 'Your name, photo, bio — your brand'],
    Visual: BookingPageMock,
    reverse: true,
  },
  {
    num: '3',
    eyebrowKey: 'step3_eyebrow',
    eyebrowFallback: 'Sync',
    titleKey: 'step3_title',
    descKey: 'step3_desc',
    bullets: ['step3_bullet1', 'step3_bullet2'],
    bulletFallbacks: ['Two-way Google Calendar sync', 'Automatic reminders for players'],
    Visual: CalendarMock,
    reverse: false,
  },
];

export function HowItWorksSection() {
  const { t } = useTranslation('marketing');

  return (
    <section id="how-it-works" className="py-16 md:py-24 lg:py-32 section-cream">
      <div className="max-w-7xl mx-auto px-4 md:px-6">
        <div className="max-w-3xl mb-16">
          <span className="eyebrow">{t('homev2.howItWorks.eyebrow', 'How it works')}</span>
          <h2 className="mt-4 font-display text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
            {t('homev2.howItWorks.headline')}
          </h2>
        </div>

        <div className="space-y-20 md:space-y-28">
          {steps.map(({ num, eyebrowKey, eyebrowFallback, titleKey, descKey, bullets, bulletFallbacks, Visual, reverse }) => (
            <div
              key={num}
              className="grid md:grid-cols-2 gap-10 md:gap-16 items-center"
            >
              <div className={reverse ? 'md:order-2' : ''}>
                <div className="flex items-center gap-3 mb-4">
                  <span className="w-9 h-9 rounded-full bg-brand-500 text-white font-display font-bold flex items-center justify-center">
                    {num}
                  </span>
                  <span className="text-xs font-semibold tracking-[0.18em] uppercase text-brand-600">
                    {t(`homev2.howItWorks.${eyebrowKey}`, eyebrowFallback)}
                  </span>
                </div>
                <h3 className="font-display text-3xl md:text-4xl font-extrabold tracking-[-0.02em] leading-tight text-navy-900">
                  {t(`homev2.howItWorks.${titleKey}`)}
                </h3>
                <p className="mt-4 text-navy-700 text-lg leading-relaxed">
                  {t(`homev2.howItWorks.${descKey}`)}
                </p>
                <ul className="mt-6 space-y-3">
                  {bullets.map((b, i) => (
                    <li key={b} className="flex items-start gap-3 text-navy-900">
                      <Check className="h-5 w-5 text-brand-600 mt-0.5 flex-shrink-0" />
                      <span>{t(`homev2.howItWorks.${b}`, bulletFallbacks[i])}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={reverse ? 'md:order-1' : ''}>
                <Visual />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
