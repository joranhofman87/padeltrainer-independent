import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ChevronRight, Clock, MapPin, Users, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgendaSlot } from '@/lib/agendaSlots';

const MAX_CHIPS = 5;

function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function AgendaListItem({
  slot,
  basePath,
  showTrainer = false,
}: {
  slot: AgendaSlot;
  basePath: string;            // '/app/trainer' | '/app/academy'
  showTrainer?: boolean;
}) {
  const { t } = useTranslation('common');
  const detailHref = `${basePath}/slot/${slot.id}`;
  const start = parseISO(slot.start_time);
  const end = parseISO(slot.end_time);
  const visible = slot.booked_players.slice(0, MAX_CHIPS);
  const overflow = slot.booked_players.length - visible.length;

  return (
    <Card className={cn('transition-colors hover:bg-muted/40', slot.is_past && 'opacity-70')}>
      <CardContent className="flex items-start gap-3 p-3 sm:p-4">
        {/* time column */}
        <div className="flex w-14 shrink-0 flex-col items-center justify-center text-center">
          <span className="font-display text-base font-semibold tabular-nums leading-tight">{format(start, 'HH:mm')}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{format(end, 'HH:mm')}</span>
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {slot.cyclus_name && <span className="truncate font-medium">{slot.cyclus_name}</span>}
            {showTrainer && slot.trainer_name && (
              <span className="text-sm text-muted-foreground">· {slot.trainer_name}</span>
            )}
            <Badge variant="secondary" className="gap-1 text-xs">
              <Users className="h-3 w-3" />
              {slot.active_bookings}
              {slot.pending_bookings > 0 && <span className="text-amber-600">+{slot.pending_bookings}</span>}
              /{slot.max_participants}
            </Badge>
            {slot.is_past && !slot.has_report && (
              <Badge variant="outline" className="gap-1 border-amber-300 text-xs text-amber-700">
                <AlertCircle className="h-3 w-3" />
                {t('agenda.reportNeeded', 'Report needed')}
              </Badge>
            )}
          </div>

          {(slot.location_name || slot.location_logo) && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {slot.location_logo ? (
                <img src={slot.location_logo} alt="" className="h-4 w-4 rounded object-contain" />
              ) : (
                <MapPin className="h-3.5 w-3.5" />
              )}
              <span className="truncate">{slot.location_name}</span>
            </div>
          )}

          {visible.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {visible.map((p) => (
                <span
                  key={p.id}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                    p.status === 'pending' && 'border-amber-300 text-amber-700',
                  )}
                >
                  <Avatar className="h-4 w-4">
                    <AvatarImage src={undefined} alt="" />
                    <AvatarFallback className="text-[9px]">{initials(p.name)}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-[10rem] truncate">{p.name}</span>
                </span>
              ))}
              {overflow > 0 && <span className="text-xs text-muted-foreground">+{overflow}</span>}
            </div>
          ) : (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {t('agenda.noBookings', 'No players booked yet')}
            </p>
          )}
        </div>

        <Button asChild size="sm" variant="ghost" className="shrink-0 self-center" aria-label={t('agenda.openDetails', 'Open session')}>
          <Link to={detailHref}>
            {t('agenda.details', 'Details')}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
