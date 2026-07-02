import { CalendarPlus, Sparkles, RefreshCw, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SetupHub, type SetupOption } from '@/components/setup/SetupHub';

/**
 * Academy "Sessies" hub — one place that explains every way to add sessions /
 * registrations to the agenda and links to where you do each. Reduces "which button
 * do I use?" confusion. Cards mirror the CTAs scattered across the Schedule/Agenda/
 * Registrations pages.
 */
export default function AcademySessions() {
  const { t } = useTranslation('academy');

  const options: SetupOption[] = [
    {
      id: 'new-session',
      icon: CalendarPlus,
      iconBg: 'bg-sky-500/10',
      iconColor: 'text-sky-600',
      title: t('sessions.newSession.title', 'Nieuwe sessie'),
      description: t(
        'sessions.newSession.description',
        'Voeg één losse training toe aan de agenda — kies datum, tijd, trainer en locatie. Handig voor een eenmalige of extra les.',
      ),
      cta: t('sessions.newSession.cta', 'Sessie toevoegen'),
      to: '/app/academy/slot/new',
      testId: 'sessions-new-session',
    },
    {
      id: 'generate',
      icon: Sparkles,
      iconBg: 'bg-violet-500/10',
      iconColor: 'text-violet-600',
      title: t('sessions.generate.title', 'Snel sessies genereren'),
      description: t(
        'sessions.generate.description',
        'Genereer in één keer een hele reeks trainingen (bijv. elke week op hetzelfde tijdstip) voor een volledige periode. Ideaal om een nieuw blok in te plannen.',
      ),
      cta: t('sessions.generate.cta', 'Sessies genereren'),
      to: '/app/academy/slot/generate',
      testId: 'sessions-generate',
    },
    {
      id: 'next-round',
      icon: RefreshCw,
      iconBg: 'bg-emerald-500/10',
      iconColor: 'text-emerald-600',
      title: t('sessions.nextRound.title', 'Volgende ronde opzetten'),
      description: t(
        'sessions.nextRound.description',
        'Neem een bestaande groep mee naar een nieuwe ronde: kopieer de sessies en nodig dezelfde spelers uit om opnieuw te boeken en te betalen.',
      ),
      cta: t('sessions.nextRound.cta', 'Ronde opzetten'),
      to: '/app/academy/cycles/rebook',
      testId: 'sessions-next-round',
    },
    {
      id: 'registration',
      icon: ClipboardList,
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-600',
      title: t('sessions.registration.title', 'Nieuwe inschrijving'),
      description: t(
        'sessions.registration.description',
        'Maak een inschrijfformulier waarop spelers zich zelf voor een cursus of event kunnen aanmelden — inclusief online betaling.',
      ),
      cta: t('sessions.registration.cta', 'Inschrijving maken'),
      to: '/app/academy/registrations/new?type=registration',
      testId: 'sessions-registration',
    },
  ];

  return (
    <SetupHub
      title={t('sessions.title', 'Sessies')}
      description={t(
        'sessions.subtitle',
        'Alle manieren om trainingen en inschrijvingen op te zetten, op één plek. Kies wat je wilt doen.',
      )}
      options={options}
      testId="page-academy-sessions"
    />
  );
}
