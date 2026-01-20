import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Plus, Pencil, Trash2, Users, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  getUserClubProfiles,
  getClubPlayers,
  addClubPlayer,
  updateClubPlayer,
  deleteClubPlayer,
  type ClubPlayer,
} from '@/lib/club';

export default function ClubPlayers() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();
  const [clubProfileId, setClubProfileId] = useState<string | null>(null);
  const [players, setPlayers] = useState<ClubPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Dialog state
  const [showDialog, setShowDialog] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<ClubPlayer | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deletingPlayer, setDeletingPlayer] = useState<ClubPlayer | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    skill_rating: '',
    notes: '',
  });

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    async function fetchData() {
      if (!user) return;

      try {
        const userClubs = await getUserClubProfiles(user.id);
        if (userClubs.length === 0) {
          navigate('/club');
          return;
        }

        const clubId = userClubs[0].id;
        setClubProfileId(clubId);
        
        const playersData = await getClubPlayers(clubId);
        setPlayers(playersData);
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [user, navigate]);

  const openAddDialog = () => {
    setEditingPlayer(null);
    setFormData({
      full_name: '',
      email: '',
      phone: '',
      skill_rating: '',
      notes: '',
    });
    setShowDialog(true);
  };

  const openEditDialog = (player: ClubPlayer) => {
    setEditingPlayer(player);
    setFormData({
      full_name: player.full_name,
      email: player.email,
      phone: player.phone || '',
      skill_rating: player.skill_rating?.toString() || '',
      notes: player.notes || '',
    });
    setShowDialog(true);
  };

  const handleSave = async () => {
    if (!clubProfileId || !formData.full_name || !formData.email) {
      toast({
        title: t('common:error'),
        description: 'Please fill in required fields',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      const playerData = {
        full_name: formData.full_name,
        email: formData.email,
        phone: formData.phone || null,
        skill_rating: formData.skill_rating ? parseFloat(formData.skill_rating) : null,
        rating_system: 'knltb',
        notes: formData.notes || null,
        linked_profile_id: null,
      };

      if (editingPlayer) {
        const updated = await updateClubPlayer(editingPlayer.id, playerData);
        if (updated) {
          setPlayers(players.map(p => p.id === updated.id ? updated : p));
          toast({ title: t('common:saved') });
        }
      } else {
        const newPlayer = await addClubPlayer(clubProfileId, playerData);
        if (newPlayer) {
          setPlayers([...players, newPlayer]);
          toast({ title: t('common:saved') });
        }
      }
      setShowDialog(false);
    } catch (error) {
      console.error('Error saving player:', error);
      toast({
        title: t('common:error'),
        description: 'Failed to save player',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingPlayer) return;

    try {
      const success = await deleteClubPlayer(deletingPlayer.id);
      if (success) {
        setPlayers(players.filter(p => p.id !== deletingPlayer.id));
        toast({ title: 'Player removed' });
      }
    } catch (error) {
      console.error('Error deleting player:', error);
    } finally {
      setShowDeleteDialog(false);
      setDeletingPlayer(null);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-10 w-48 mb-6" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={() => navigate('/club')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="text-xl font-semibold">{t('players.title')}</h1>
            </div>
            <Button onClick={openAddDialog}>
              <Plus className="h-4 w-4 mr-2" />
              {t('players.addPlayer')}
            </Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        {players.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">{t('players.empty')}</h3>
              <p className="text-muted-foreground mb-4">{t('players.emptyDescription')}</p>
              <Button onClick={openAddDialog}>
                <Plus className="h-4 w-4 mr-2" />
                {t('players.addPlayer')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t('players.title')}</CardTitle>
              <CardDescription>
                {players.length} {players.length === 1 ? 'player' : 'players'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('players.name')}</TableHead>
                    <TableHead>{t('players.email')}</TableHead>
                    <TableHead>{t('players.phone')}</TableHead>
                    <TableHead>{t('players.rating')}</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {players.map(player => (
                    <TableRow key={player.id}>
                      <TableCell className="font-medium">{player.full_name}</TableCell>
                      <TableCell>{player.email}</TableCell>
                      <TableCell>{player.phone || '-'}</TableCell>
                      <TableCell>{player.skill_rating || '-'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditDialog(player)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setDeletingPlayer(player);
                              setShowDeleteDialog(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Add/Edit Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingPlayer ? t('players.editPlayer') : t('players.addPlayer')}
              </DialogTitle>
              <DialogDescription>
                {editingPlayer 
                  ? 'Update player information'
                  : 'Add a new player to your club'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">{t('players.name')} *</Label>
                <Input
                  id="full_name"
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                  placeholder="John Doe"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t('players.email')} *</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">{t('players.phone')}</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="+31 6 12345678"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="skill_rating">{t('players.rating')}</Label>
                <Input
                  id="skill_rating"
                  type="number"
                  step="0.01"
                  value={formData.skill_rating}
                  onChange={(e) => setFormData({ ...formData, skill_rating: e.target.value })}
                  placeholder="e.g. 5.5"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">{t('players.notes')}</Label>
                <Textarea
                  id="notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Any additional notes..."
                  rows={3}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                {t('common:cancel')}
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('common:save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation */}
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('players.deleteConfirm')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('players.deleteConfirmDescription')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
                {t('players.deletePlayer')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
