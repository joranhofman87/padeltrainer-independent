import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Calendar, Trophy, ExternalLink, Pencil, Trash2, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useClubContext } from '@/components/club/ClubLayout';
import { logger } from '@/lib/logger';
import {
  getClubTournaments,
  createTournament,
  updateTournament,
  deleteTournament,
  type ClubTournament,
} from '@/lib/tournaments';

interface TournamentFormData {
  name: string;
  description: string;
  start_date: string;
  end_date: string;
  registration_url: string;
  is_published: boolean;
}

const emptyForm: TournamentFormData = {
  name: '',
  description: '',
  start_date: '',
  end_date: '',
  registration_url: '',
  is_published: false,
};

export default function ClubTournaments() {
  const { t, i18n } = useTranslation('club');
  const { toast } = useToast();
  const { activeClub } = useClubContext();
  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  const [tournaments, setTournaments] = useState<ClubTournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingTournament, setEditingTournament] = useState<ClubTournament | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<TournamentFormData>(emptyForm);

  // Access subscription fields from activeClub (these are from club_profiles table)
  const isPaidPlan = (activeClub as any)?.subscription_status === 'active' && (activeClub as any)?.subscription_tier !== 'starter';

  useEffect(() => {
    if (activeClub?.id) {
      fetchTournaments();
    }
  }, [activeClub?.id]);

  async function fetchTournaments() {
    if (!activeClub?.id) return;
    setLoading(true);
    const data = await getClubTournaments(activeClub.id);
    setTournaments(data);
    setLoading(false);
  }

  function openCreateDialog() {
    setEditingTournament(null);
    setFormData(emptyForm);
    setDialogOpen(true);
  }

  function openEditDialog(tournament: ClubTournament) {
    setEditingTournament(tournament);
    setFormData({
      name: tournament.name,
      description: tournament.description || '',
      start_date: tournament.start_date,
      end_date: tournament.end_date || '',
      registration_url: tournament.registration_url || '',
      is_published: tournament.is_published,
    });
    setDialogOpen(true);
  }

  function openDeleteDialog(id: string) {
    setDeletingId(id);
    setDeleteDialogOpen(true);
  }

  async function handleSubmit() {
    if (!activeClub?.id || !formData.name || !formData.start_date) {
      toast({
        title: t('common:error'),
        description: t('tournaments.requiredFields'),
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);

    try {
      if (editingTournament) {
        await updateTournament(editingTournament.id, {
          name: formData.name,
          description: formData.description || null,
          start_date: formData.start_date,
          end_date: formData.end_date || null,
          registration_url: formData.registration_url || null,
          is_published: formData.is_published,
        });
        toast({
          title: t('common:success'),
          description: t('tournaments.updated'),
        });
      } else {
        await createTournament({
          club_profile_id: activeClub.id,
          name: formData.name,
          description: formData.description || null,
          start_date: formData.start_date,
          end_date: formData.end_date || null,
          registration_url: formData.registration_url || null,
          image_url: null,
          is_published: formData.is_published,
        });
        toast({
          title: t('common:success'),
          description: t('tournaments.created'),
        });
      }

      setDialogOpen(false);
      fetchTournaments();
    } catch (error) {
      logger.error('Error saving tournament', error as Error, { component: 'ClubTournaments', clubId: activeClub?.id });
      toast({
        title: t('common:error'),
        description: t('tournaments.error'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deletingId) return;

    try {
      await deleteTournament(deletingId);
      toast({
        title: t('common:success'),
        description: t('tournaments.deleted'),
      });
      setDeleteDialogOpen(false);
      setDeletingId(null);
      fetchTournaments();
    } catch (error) {
      logger.error('Error deleting tournament', error as Error, { component: 'ClubTournaments', tournamentId: deletingId });
      toast({
        title: t('common:error'),
        description: t('tournaments.error'),
        variant: 'destructive',
      });
    }
  }

  async function togglePublished(tournament: ClubTournament) {
    await updateTournament(tournament.id, { is_published: !tournament.is_published });
    fetchTournaments();
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="h-6 w-6 text-primary" />
            {t('tournaments.title')}
          </h1>
          <p className="text-muted-foreground">{t('tournaments.description')}</p>
        </div>
        <Button onClick={openCreateDialog} disabled={!isPaidPlan && tournaments.length >= 1}>
          <Plus className="h-4 w-4 mr-2" />
          {t('tournaments.add')}
        </Button>
      </div>

      {!isPaidPlan && tournaments.length >= 1 && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <Lock className="h-5 w-5 text-amber-500" />
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-400">
                {t('tournaments.upgradeCta')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('tournaments.upgradeDescription')}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {tournaments.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Trophy className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{t('tournaments.empty')}</h3>
            <p className="text-muted-foreground mb-4">{t('tournaments.emptyDescription')}</p>
            <Button onClick={openCreateDialog}>
              <Plus className="h-4 w-4 mr-2" />
              {t('tournaments.add')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {tournaments.map((tournament) => (
            <Card key={tournament.id} className={!tournament.is_published ? 'opacity-60' : ''}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {tournament.name}
                      {!tournament.is_published && (
                        <Badge variant="outline" className="text-xs">
                          <EyeOff className="h-3 w-3 mr-1" />
                          {t('tournaments.draft')}
                        </Badge>
                      )}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-2 mt-1">
                      <Calendar className="h-4 w-4" />
                      {format(new Date(tournament.start_date), 'PPP', { locale: dateLocale })}
                      {tournament.end_date && tournament.end_date !== tournament.start_date && (
                        <> - {format(new Date(tournament.end_date), 'PPP', { locale: dateLocale })}</>
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => togglePublished(tournament)}
                      title={tournament.is_published ? t('tournaments.unpublish') : t('tournaments.publish')}
                    >
                      {tournament.is_published ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(tournament)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => openDeleteDialog(tournament.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {tournament.description && (
                  <p className="text-sm text-muted-foreground mb-3">{tournament.description}</p>
                )}
                {tournament.registration_url && (
                  <a
                    href={tournament.registration_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-4 w-4" />
                    {t('tournaments.registrationLink')}
                  </a>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingTournament ? t('tournaments.edit') : t('tournaments.add')}
            </DialogTitle>
            <DialogDescription>
              {t('tournaments.formDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('tournaments.name')} *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('tournaments.namePlaceholder')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t('tournaments.descriptionLabel')}</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={t('tournaments.descriptionPlaceholder')}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="start_date">{t('tournaments.startDate')} *</Label>
                <Input
                  id="start_date"
                  type="date"
                  value={formData.start_date}
                  onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end_date">{t('tournaments.endDate')}</Label>
                <Input
                  id="end_date"
                  type="date"
                  value={formData.end_date}
                  onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="registration_url">{t('tournaments.registrationUrl')}</Label>
              <Input
                id="registration_url"
                type="url"
                value={formData.registration_url}
                onChange={(e) => setFormData({ ...formData, registration_url: e.target.value })}
                placeholder="https://..."
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="is_published">{t('tournaments.publishNow')}</Label>
              <Switch
                id="is_published"
                checked={formData.is_published}
                onCheckedChange={(checked) => setFormData({ ...formData, is_published: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingTournament ? t('common:save') : t('tournaments.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tournaments.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('tournaments.deleteConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              {t('tournaments.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
