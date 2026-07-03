import { useState, useEffect } from 'react';
import { WaitingListStatusBadge } from './WaitingListStatusBadge';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Loader2, Trash2, Bell } from 'lucide-react';
import { format } from 'date-fns';
import {
  getPlayerWaitingListEntries,
  deleteWaitingListEntry,
  WaitingListEntry,
} from '@/lib/waitingList';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';

export default function MyWaitingListEntries() {
  const { t } = useTranslation('waitingList');
  const { profile } = useAuth();
  const { toast } = useToast();

  const [entries, setEntries] = useState<WaitingListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // One controlled confirm keyed by entry id instead of an AlertDialog per row.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchEntries = async () => {
    if (!profile?.id) return;
    setLoading(true);
    const { data, error } = await getPlayerWaitingListEntries(profile.id);
    if (error) {
      logger.error('Error fetching waiting list entries', error instanceof Error ? error : new Error(String(error)), { component: 'MyWaitingListEntries' });
    }
    setEntries(data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchEntries();
  }, [profile?.id]);

  const handleDelete = async (entryId: string) => {
    setDeletingId(entryId);
    try {
      const { error } = await deleteWaitingListEntry(entryId);

      if (error) {
        toast({
          title: 'Error',
          description: getFriendlyErrorMessage(error, t('myEntries.deleteError', 'Could not remove you from the waiting list. Please try again.')),
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: 'Removed',
        description: 'You have been removed from the waiting list',
      });
      fetchEntries();
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
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
                <WaitingListStatusBadge status={entry.status} labelPrefix="myEntries" />
                <span className="text-sm capitalize">
                  {t(`form.lessonTypes.${entry.lesson_type}`)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t('myEntries.joinedOn')}: {format(new Date(entry.created_at), 'MMM d, yyyy')}
              </p>
            </div>
            
            <Button
              variant="ghost"
              size="icon" aria-label="Delete"
              className="text-muted-foreground hover:text-destructive"
              disabled={deletingId === entry.id}
              onClick={() => setConfirmDeleteId(entry.id)}
            >
              {deletingId === entry.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          </div>
        ))}
        <ConfirmDialog
          open={!!confirmDeleteId}
          onOpenChange={(open) => !open && setConfirmDeleteId(null)}
          title={t('myEntries.remove')}
          description={t('myEntries.removeConfirm')}
          confirmLabel={t('myEntries.remove')}
          cancelLabel="Cancel"
          variant="default"
          loading={!!confirmDeleteId && deletingId === confirmDeleteId}
          onConfirm={() => {
            if (confirmDeleteId) return handleDelete(confirmDeleteId);
          }}
        />
      </CardContent>
    </Card>
  );
}
