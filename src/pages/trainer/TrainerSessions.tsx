import { CalendarPlus, Sparkles, RefreshCw, ClipboardList } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SetupHub, type SetupOption } from '@/components/setup/SetupHub';

/**
 * Trainer "Sessions" hub — the trainer-side counterpart to the academy hub. Same idea
 * (explain each way to add sessions + link to it) but wired to the /app/trainer/* routes.
 * "Next round" is the trainer's bulk-copy flow (the whole-group rebook wizard is
 * academy-only).
 */
export default function TrainerSessions() {
  const { t } = useTranslation('trainer');

  const options: SetupOption[] = [
    {
      id: 'new-session',
      icon: CalendarPlus,
      iconBg: 'bg-sky-500/10',
      iconColor: 'text-sky-600',
      title: t('sessions.newSession.title', 'Nieuwe sessie'),
      description: t(
        'sessions.newSession.description',
        'Voeg één losse training toe aan je agenda — kies datum, tijd en locatie. Handig voor een eenmalige of extra les.',
      ),
      cta: t('sessions.newSession.cta', 'Sessie toevoegen'),
      to: '/app/trainer/slot/new',
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
      to: '/app/trainer/slot/generate',
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
        'Kopieer je huidige sessies naar een nieuwe periode, zodat je een volgend blok niet helemaal opnieuw hoeft in te plannen.',
      ),
      cta: t('sessions.nextRound.cta', 'Ronde opzetten'),
      to: '/app/trainer/cycles/bulk-copy',
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
      to: '/app/trainer/cycles/new',
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
      testId="page-trainer-sessions"
    />
  );
}
