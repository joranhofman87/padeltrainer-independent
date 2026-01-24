import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Trophy, Calendar, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getPublishedTournaments, type ClubTournament } from '@/lib/tournaments';

interface UpcomingTournamentsProps {
  clubProfileId: string;
}

export function UpcomingTournaments({ clubProfileId }: UpcomingTournamentsProps) {
  const { t, i18n } = useTranslation('common');
  const dateLocale = i18n.language === 'nl' ? nl : enUS;
  const [tournaments, setTournaments] = useState<ClubTournament[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchTournaments() {
      const data = await getPublishedTournaments(clubProfileId);
      setTournaments(data);
      setLoading(false);
    }
    fetchTournaments();
  }, [clubProfileId]);

  if (loading || tournaments.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Trophy className="h-5 w-5 text-primary" />
          {t('locations.upcomingTournaments')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {tournaments.map((tournament) => (
          <div
            key={tournament.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg"
          >
            <div className="space-y-1">
              <h4 className="font-medium">{tournament.name}</h4>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span>
                  {format(new Date(tournament.start_date), 'PPP', { locale: dateLocale })}
                  {tournament.end_date && tournament.end_date !== tournament.start_date && (
                    <> - {format(new Date(tournament.end_date), 'PPP', { locale: dateLocale })}</>
                  )}
                </span>
              </div>
              {tournament.description && (
                <p className="text-sm text-muted-foreground line-clamp-2">{tournament.description}</p>
              )}
            </div>
            {tournament.registration_url && (
              <Button variant="outline" size="sm" asChild className="shrink-0">
                <a href={tournament.registration_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('locations.register')}
                </a>
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
