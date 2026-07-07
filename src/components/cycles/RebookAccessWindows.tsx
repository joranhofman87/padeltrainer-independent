import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { User, Users, Globe, ChevronRight } from 'lucide-react';

interface Props {
  priorityWindowDays: number;
  setPriorityWindowDays: (n: number) => void;
  enableMemberWindow: boolean;
  setEnableMemberWindow: (b: boolean) => void;
  memberWindowDays: number;
  setMemberWindowDays: (n: number) => void;
  /** When true the member window can't be switched off (e.g. a priority list needs it). */
  lockMemberWindow?: boolean;
  lockMemberWindowHint?: string;
}

/**
 * "Voorrang en ledenvenster" — visualises who can book when after a rebook goes
 * live, as a phase timeline: own slot → free slots for returning players → public.
 * Presentation only; the numeric settings are unchanged.
 */
export function RebookAccessWindows({
  priorityWindowDays,
  setPriorityWindowDays,
  enableMemberWindow,
  setEnableMemberWindow,
  memberWindowDays,
  setMemberWindowDays,
  lockMemberWindow = false,
  lockMemberWindowHint,
}: Props) {
  const { t } = useTranslation('cycles');
  const daysUnit = t('rebookShared.daysUnit', 'dagen');
  const memberStart = priorityWindowDays;
  const publicStart = priorityWindowDays + (enableMemberWindow ? memberWindowDays : 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('rebookShared.windowsTitle', 'Voorrang en ledenvenster')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          {t('rebookShared.windowsIntro', 'Wie mag wanneer boeken nadat de nieuwe ronde online komt?')}
        </p>

        {/* Phase timeline */}
        <div className="flex flex-col sm:flex-row sm:items-stretch gap-2">
          <Phase
            icon={<User className="h-4 w-4" />}
            tone="brand"
            dayLabel={t('rebookShared.dayMarker', 'Dag {{n}}', { n: 0 })}
            title={t('rebookShared.phaseOwnTitle', 'Eigen plek')}
            desc={t('rebookShared.phaseOwnDesc', 'Zelfde dag & tijd, gereserveerd voor de speler')}
            days={`${priorityWindowDays} ${daysUnit}`}
          />
          {enableMemberWindow && (
            <>
              <Arrow />
              <Phase
                icon={<Users className="h-4 w-4" />}
                tone="slate"
                dayLabel={t('rebookShared.dayMarker', 'Dag {{n}}', { n: memberStart })}
                title={t('rebookShared.phaseMembersTitle', 'Vrije plekken')}
                desc={t('rebookShared.phaseMembersDesc', 'Vaste spelers kiezen eerst, vóór het publiek')}
                days={`${memberWindowDays} ${daysUnit}`}
              />
            </>
          )}
          <Arrow />
          <Phase
            icon={<Globe className="h-4 w-4" />}
            tone="muted"
            dayLabel={t('rebookShared.dayMarker', 'Dag {{n}}', { n: publicStart })}
            title={t('rebookShared.phasePublicTitle', 'Publiek')}
            desc={t('rebookShared.phasePublicDesc', 'Iedereen kan boeken')}
          />
        </div>

        {/* Controls */}
        <div className="space-y-4">
          <div className="max-w-md">
            <Label>
              {t('rebookShared.priorityLabel', 'Hoelang mogen spelers hun eigen plek (zelfde dag & tijd) opnieuw boeken?')}
            </Label>
            <div className="flex items-center gap-2 mt-1">
              <Input
                type="number"
                min={1}
                max={60}
                value={priorityWindowDays}
                onChange={(e) => setPriorityWindowDays(Number(e.target.value))}
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">{daysUnit}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookShared.priorityHint', 'De plek blijft voor hen gereserveerd totdat ze nee zeggen of deze periode voorbij is.')}
            </p>
          </div>

          <label className={cn('flex items-start gap-3 max-w-md', lockMemberWindow ? 'cursor-not-allowed opacity-70' : 'cursor-pointer')}>
            <Checkbox
              className="mt-0.5"
              checked={enableMemberWindow}
              disabled={lockMemberWindow}
              onCheckedChange={(v) => setEnableMemberWindow(Boolean(v))}
            />
            <span className="text-sm">
              {t('rebookShared.enableMemberWindow', 'Geef vaste spelers daarna eerst keuze uit vrije plekken, vóór het publiek')}
              {lockMemberWindow && lockMemberWindowHint && (
                <span className="block text-xs text-muted-foreground mt-1">{lockMemberWindowHint}</span>
              )}
            </span>
          </label>

          {enableMemberWindow && (
            <div className="max-w-md">
              <Label>{t('rebookShared.memberLabel', 'Hoelang houden vaste spelers voorrang op vrije plekken?')}</Label>
              <div className="flex items-center gap-2 mt-1">
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={memberWindowDays}
                  onChange={(e) => setMemberWindowDays(Number(e.target.value))}
                  className="w-24"
                />
                <span className="text-sm text-muted-foreground">{daysUnit}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t('rebookShared.memberHint', 'Daarna kan iedereen de overgebleven plekken boeken.')}
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Phase({
  icon,
  tone,
  dayLabel,
  title,
  desc,
  days,
}: {
  icon: ReactNode;
  tone: 'brand' | 'slate' | 'muted';
  dayLabel: string;
  title: string;
  desc: string;
  days?: string;
}) {
  const toneClass =
    tone === 'brand'
      ? 'border-[hsl(var(--brand-500))] bg-[hsl(var(--brand-50))]'
      : tone === 'slate'
        ? 'border-slate-300 bg-white'
        : 'border-slate-200 bg-slate-50';
  const iconTone =
    tone === 'brand' ? 'text-[hsl(var(--brand-600))]' : tone === 'slate' ? 'text-slate-600' : 'text-slate-400';
  return (
    <div className="flex-1 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{dayLabel}</div>
      <div className={cn('rounded-lg border p-3 h-full', toneClass)}>
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
          <span className={iconTone}>{icon}</span>
          {title}
        </div>
        <p className="text-xs text-muted-foreground mt-1">{desc}</p>
        {days && <div className="text-xs font-semibold text-slate-700 mt-2">{days}</div>}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="hidden sm:flex items-center justify-center self-center pt-5 text-slate-300">
      <ChevronRight className="h-5 w-5" />
    </div>
  );
}
