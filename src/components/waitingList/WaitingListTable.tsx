import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Users, Phone, Archive, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import {
  getOwnerWaitingListEntries,
  updateWaitingListEntryStatus,
  WaitingListEntry,
  WaitingListStatus,
  OwnerType,
} from '@/lib/waitingList';

interface PlayerInfo {
  full_name: string | null;
  email: string | null;
  phone: string | null;
}

interface WaitingListTableProps {
  ownerType: OwnerType;
  ownerId: string;
}

export default function WaitingListTable({
  ownerType,
  ownerId,
}: WaitingListTableProps) {
  const { t } = useTranslation('waitingList');
  const { toast } = useToast();

  const [entries, setEntries] = useState<WaitingListEntry[]>([]);
  const [playerInfo, setPlayerInfo] = useState<Record<string, PlayerInfo>>({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<WaitingListStatus | 'all'>('active');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const fetchEntries = async () => {
    setLoading(true);
    const status = statusFilter === 'all' ? undefined : statusFilter;
    const { data, error } = await getOwnerWaitingListEntries(ownerType, ownerId, status);
    
    if (error) {
      console.error('Error fetching waiting list:', error);
      toast({
        title: 'Error',
        description: 'Failed to load waiting list',
        variant: 'destructive',
      });
    }
    
    setEntries(data || []);

    // Fetch player info for all entries
    if (data && data.length > 0) {
      const playerIds = data.map((e) => e.player_id);
      const { data: profiles } = await supabase
        .from('profiles_public' as any)
        .select('id, full_name, phone')
        .in('id', playerIds);

      if (profiles) {
        const infoMap: Record<string, PlayerInfo> = {};
        (profiles as any[]).forEach((p: any) => {
          infoMap[p.id] = {
            full_name: p.full_name,
            email: null, // email not available in profiles_public
            phone: p.phone,
          };
        });
        setPlayerInfo(infoMap);
      }
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchEntries();
  }, [ownerType, ownerId, statusFilter]);

  const handleStatusUpdate = async (entryId: string, newStatus: WaitingListStatus) => {
    setUpdatingId(entryId);
    const { error } = await updateWaitingListEntryStatus(entryId, newStatus);
    setUpdatingId(null);

    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    toast({
      title: 'Updated',
      description: `Entry marked as ${newStatus}`,
    });
    fetchEntries();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="default">{t('management.filters.active')}</Badge>;
      case 'contacted':
        return <Badge variant="secondary">{t('management.filters.contacted')}</Badge>;
      case 'archived':
        return <Badge variant="outline">{t('management.filters.archived')}</Badge>;
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          {t('management.title')}
          {entries.length > 0 && (
            <Badge variant="secondary" className="ml-2">
              {entries.length}
            </Badge>
          )}
        </CardTitle>
        <Select
          value={statusFilter}
          onValueChange={(val) => setStatusFilter(val as WaitingListStatus | 'all')}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('management.filters.all')}</SelectItem>
            <SelectItem value="active">{t('management.filters.active')}</SelectItem>
            <SelectItem value="contacted">{t('management.filters.contacted')}</SelectItem>
            <SelectItem value="archived">{t('management.filters.archived')}</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>{t('management.empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Player</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => {
                  const player = playerInfo[entry.player_id];
                  const isUpdating = updatingId === entry.id;

                  return (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">{player?.full_name || 'Unknown'}</p>
                          {player?.email && (
                            <p className="text-xs text-muted-foreground">{player.email}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="capitalize">
                          {t(`form.lessonTypes.${entry.lesson_type}`)}
                        </span>
                        {entry.has_group && entry.group_size && (
                          <span className="text-xs text-muted-foreground ml-1">
                            ({entry.group_size} people)
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {entry.rating ? (
                          <span>
                            {entry.rating} <span className="text-xs text-muted-foreground uppercase">{entry.rating_system}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(entry.status)}</TableCell>
                      <TableCell>
                        {format(new Date(entry.created_at), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {player?.phone && (
                            <Button
                              variant="ghost"
                              size="icon"
                              asChild
                            >
                              <a href={`tel:${player.phone}`}>
                                <Phone className="h-4 w-4" />
                              </a>
                            </Button>
                          )}
                          {entry.status === 'active' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleStatusUpdate(entry.id, 'contacted')}
                              disabled={isUpdating}
                            >
                              {isUpdating ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <CheckCircle className="h-4 w-4 mr-1" />
                                  {t('management.markContacted')}
                                </>
                              )}
                            </Button>
                          )}
                          {entry.status !== 'archived' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleStatusUpdate(entry.id, 'archived')}
                              disabled={isUpdating}
                            >
                              <Archive className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
