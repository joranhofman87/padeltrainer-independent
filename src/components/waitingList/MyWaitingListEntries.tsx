import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, Bell } from 'lucide-react';
import { format } from 'date-fns';
import {
  getPlayerWaitingListEntries,
  deleteWaitingListEntry,
  WaitingListEntry,
} from '@/lib/waitingList';

export default function MyWaitingListEntries() {
  const { t } = useTranslation('waitingList');
  const { profile } = useAuth();
  const { toast } = useToast();

  const [entries, setEntries] = useState<WaitingListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchEntries = async () => {
    if (!profile?.id) return;
    setLoading(true);
    const { data, error } = await getPlayerWaitingListEntries(profile.id);
    if (error) {
      console.error('Error fetching waiting list entries:', error);
    }
    setEntries(data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchEntries();
  }, [profile?.id]);

  const handleDelete = async (entryId: string) => {
    setDeletingId(entryId);
    const { error } = await deleteWaitingListEntry(entryId);
    setDeletingId(null);

    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    toast({
      title: 'Removed',
      description: 'You have been removed from the waiting list',
    });
    fetchEntries();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="default">{t('myEntries.active')}</Badge>;
      case 'contacted':
        return <Badge variant="secondary">{t('myEntries.contacted')}</Badge>;
      case 'archived':
        return <Badge variant="outline">{t('myEntries.archived')}</Badge>;
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (entries.length === 0) {
    return null; // Don't show the section if no entries
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bell className="h-5 w-5" />
          {t('myEntries.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {getStatusBadge(entry.status)}
                <span className="text-sm capitalize">
                  {t(`form.lessonTypes.${entry.lesson_type}`)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t('myEntries.joinedOn')}: {format(new Date(entry.created_at), 'MMM d, yyyy')}
              </p>
            </div>
            
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={deletingId === entry.id}
                >
                  {deletingId === entry.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('myEntries.remove')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('myEntries.removeConfirm')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => handleDelete(entry.id)}>
                    {t('myEntries.remove')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
