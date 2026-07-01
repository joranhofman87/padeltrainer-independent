import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { nl, enUS, es, de, fr } from 'date-fns/locale';
import { Calendar, MapPin, Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { formatPrice } from '@/lib/pricing';
import { usePublicAvailability } from '@/hooks/usePublicAvailability';

interface AcademyPublicOpenSlotsProps {
  academyId: string;
  academySlug: string;
}

const DATE_LOCALES: Record<string, typeof enUS> = { nl, en: enUS, es, de, fr };

export function AcademyPublicOpenSlots({ academyId, academySlug }: AcademyPublicOpenSlotsProps) {
  const { t, i18n } = useTranslation(['trainer', 'common']);
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const localizePath = useLocalizedPathFn();
  const dateLocale = DATE_LOCALES[i18n.language] || enUS;
  const { dayGroups, loading } = usePublicAvailability({ type: 'academy', academyId });

  if (loading || dayGroups.length === 0) {
    return null;
  }

  const totalSlots = dayGroups.reduce((sum, g) => sum + g.slots.length, 0);
  const displayGroups = showAll ? dayGroups : dayGroups.slice(0, 3);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            {t('common:availableSlots', 'Available Slots')}
          </CardTitle>
          <Badge variant="secondary" className="text-sm">
            {totalSlots} {totalSlots === 1 ? t('common:slot', 'slot') : t('common:slots', 'slots')}
          </Badge>
        </div>
        <CardDescription>
          {t('common:upcomingAvailability', 'Upcoming available time slots')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {displayGroups.map(group => (
          <div key={group.date.toISOString()} className="space-y-2">
            <h4 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
              {format(group.date, 'EEEE d MMMM', { locale: dateLocale })}
            </h4>
            <div className="space-y-2">
              {group.slots.map(slot => (
                <div
                  key={slot.id}
                  className="flex items-center justify-between p-3 border rounded-lg transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="text-center min-w-[60px]">
                      <p className="font-semibold text-sm">
                        {format(parseISO(slot.start_time), 'HH:mm')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {format(parseISO(slot.end_time), 'HH:mm')}
                      </p>
                    </div>
                    <div className="flex-1 min-w-0">
                      {slot.trainer_name && (
                        <p className="text-sm font-medium truncate">{slot.trainer_name}</p>
                      )}
                      <div className="flex flex-wrap gap-2 mt-1">
                        <Badge variant={slot.cyclus_id ? 'default' : 'outline'} className="text-xs">
                          {slot.cyclus_name || t('common:singleSession', 'Single session')}
                        </Badge>
                        {slot.court_type && (
                          <Badge variant="outline" className="text-xs">
                            {slot.court_type === 'indoor' ? '🏠' : '☀️'}{' '}
                            {slot.court_type === 'indoor' ? 'Indoor' : 'Outdoor'}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {slot.location_name && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" />
                            {slot.location_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Users className="h-3 w-3" />
                          {slot.spots_left} {slot.spots_left === 1 ? t('common:spotLeft', 'spot left') : t('common:spotsLeft', 'spots left')}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 ml-2">
                    <div className="text-right space-y-0.5">
                      {slot.price_per_session != null && slot.price_per_session > 0 && (
                        <p className="text-sm font-semibold">{formatPrice(slot.price_per_session)}<span className="text-xs font-normal text-muted-foreground">/{t('common:session', 'session')}</span></p>
                      )}
                      {slot.extra_costs.length > 0 && slot.extra_costs.map((ec, i) => (
                        <p key={i} className="text-xs text-muted-foreground">+ {formatPrice(ec.price)} {ec.description}</p>
                      ))}
                      {slot.extra_costs.length > 0 && slot.price_per_session != null && slot.price_per_session > 0 && (
                        <p className="text-xs font-semibold border-t border-border pt-0.5">
                          {formatPrice(slot.price_per_session + slot.extra_costs.reduce((sum, ec) => sum + ec.price, 0))}
                          <span className="font-normal text-muted-foreground">/{t('common:session', 'session')}</span>
                        </p>
                      )}
                      {slot.cyclus_id && slot.total_price != null && slot.total_price > 0 && (
                        <p className="text-xs text-muted-foreground">{t('common:total', 'Total')}: {formatPrice(slot.total_price)}</p>
                      )}
                      {slot.split_payment && (
                        <p className="text-[10px] text-muted-foreground">{t('common:splitAmongPlayers', 'Verdeeld over spelers')}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (slot.cyclus_id) {
                          navigate(localizePath(`/academies/${academySlug}/register/${slot.cyclus_id}`));
                        } else if (slot.trainer_slug) {
                          navigate(localizePath(`/book/${slot.trainer_slug}`));
                        }
                      }}
                    >
                      {t('common:book', 'Book')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {dayGroups.length > 3 && !showAll && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setShowAll(true)}
          >
            {t('common:showMore', 'Show more')} ({dayGroups.length - 3} {t('common:moreDays', 'more days')})
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
