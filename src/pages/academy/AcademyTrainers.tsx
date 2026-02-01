import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { Users, Calendar, ExternalLink, Eye, EyeOff, Trash2, Clock, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useAuth } from '@/hooks/useAuth';
import {
  getAcademyTrainersWithProfiles,
  getAcademyPendingInvitations,
  updateAcademyTrainerVisibility,
  removeAcademyTrainer,
  cancelAcademyInvitation,
  canUserAddSelfAsTrainer,
  addSelfAsAcademyTrainer,
} from '@/lib/academy';
import { InviteAcademyTrainerDialog } from '@/components/academy/InviteAcademyTrainerDialog';
import { CreateAcademyTrainerDialog } from '@/components/academy/CreateAcademyTrainerDialog';
import { EditAcademyTrainerDialog } from '@/components/academy/EditAcademyTrainerDialog';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

export default function AcademyTrainers() {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const { activeAcademy } = useAcademyContext();
  const { user, profile } = useAuth();
  const [trainers, setTrainers] = useState<any[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingVisibility, setUpdatingVisibility] = useState<string | null>(null);
  const [canAddSelf, setCanAddSelf] = useState<{
    canAdd: boolean;
    trainerProfileId?: string;
    trainerName?: string;
  }>({ canAdd: false });
  const [addingSelf, setAddingSelf] = useState(false);

  const fetchData = async () => {
    if (!activeAcademy) return;

    try {
      const [trainersData, invitationsData] = await Promise.all([
        getAcademyTrainersWithProfiles(activeAcademy.id),
        getAcademyPendingInvitations(activeAcademy.id),
      ]);
      setTrainers(trainersData);
      setPendingInvitations(invitationsData);

      // Check if current user can add themselves as a trainer
      if (user) {
        const selfCheck = await canUserAddSelfAsTrainer(user.id, activeAcademy.id);
        setCanAddSelf(selfCheck);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSelf = async () => {
    if (!activeAcademy || !user || !canAddSelf.trainerProfileId) return;

    setAddingSelf(true);
    const success = await addSelfAsAcademyTrainer(
      activeAcademy.id,
      canAddSelf.trainerProfileId,
      user.id
    );

    if (success) {
      toast.success(t('trainers.addedSelf'));
      setCanAddSelf({ canAdd: false });
      fetchData();
    } else {
      toast.error(t('common.error'));
    }
    setAddingSelf(false);
  };

  useEffect(() => {
    fetchData();
  }, [activeAcademy]);

  const handleVisibilityToggle = async (trainerId: string, show: boolean, hasName: boolean) => {
    if (!hasName && show) {
      toast.error(t('trainers.incompleteProfile'));
      return;
    }

    setUpdatingVisibility(trainerId);
    const success = await updateAcademyTrainerVisibility(trainerId, show);

    if (success) {
      setTrainers((prev) =>
        prev.map((trainer) =>
          trainer.id === trainerId ? { ...trainer, show_on_academy_page: show } : trainer
        )
      );
      toast.success(show ? t('trainers.visibilityPublic') : t('trainers.visibilityHidden'));
    } else {
      toast.error('Failed to update visibility');
    }
    setUpdatingVisibility(null);
  };

  const handleRemoveTrainer = async (trainerId: string) => {
    const success = await removeAcademyTrainer(trainerId);
    if (success) {
      setTrainers((prev) => prev.filter((t) => t.id !== trainerId));
      toast.success(t('trainers.removed'));
    } else {
      toast.error('Failed to remove trainer');
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    const success = await cancelAcademyInvitation(invitationId);
    if (success) {
      setPendingInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      toast.success(t('trainerInvitation.canceled'));
    } else {
      toast.error('Failed to cancel invitation');
    }
  };

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'T';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Skeleton className="h-10 w-48 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  const activeTrainers = trainers.filter((t) => t.status === 'active');

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">{t('trainers.title')}</h2>
          <p className="text-muted-foreground">{t('trainers.description')}</p>
        </div>
        {activeAcademy && user && profile && (
          <div className="flex items-center gap-2">
            <CreateAcademyTrainerDialog
              academyProfileId={activeAcademy.id}
              onTrainerCreated={fetchData}
            />
            <InviteAcademyTrainerDialog
              academyProfileId={activeAcademy.id}
              academyName={activeAcademy.name}
              inviterId={user.id}
              inviterName={profile.full_name || 'Academy Manager'}
              onInviteSent={fetchData}
            />
          </div>
        )}
      </div>

      {/* Add yourself as trainer banner */}
      {canAddSelf.canAdd && (
        <Card className="mb-6 border-primary/20 bg-primary/5">
          <CardContent className="py-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <UserPlus className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">{t('trainers.addSelfTitle')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('trainers.addSelfDescription')}
                  </p>
                </div>
              </div>
              <Button onClick={handleAddSelf} disabled={addingSelf}>
                {addingSelf ? t('common.saving') : t('trainers.addMyselfAsTrainer')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="active" className="space-y-4">
        <TabsList>
          <TabsTrigger value="active">
            {t('trainers.activeTrainers')} ({activeTrainers.length})
          </TabsTrigger>
          <TabsTrigger value="pending">
            {t('trainers.pendingInvitations')} ({pendingInvitations.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          {activeTrainers.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">{t('trainers.empty')}</h3>
                <p className="text-muted-foreground">{t('trainers.emptyDescription')}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {activeTrainers.map((trainer) => {
                const hasName = !!trainer.profile?.full_name;
                const isVisible = trainer.show_on_academy_page;

                return (
                  <Card key={trainer.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start gap-4">
                        <Avatar className="h-14 w-14">
                          <AvatarImage src={trainer.profile?.avatar_url || ''} />
                          <AvatarFallback>{getInitials(trainer.profile?.full_name)}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-lg truncate">
                            {trainer.profile?.full_name || 'Trainer'}
                          </CardTitle>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            {trainer.trainer_profile?.is_verified && (
                              <Badge variant="secondary" className="text-xs">
                                {t('common:verified')}
                              </Badge>
                            )}
                            <Badge
                              variant={isVisible ? 'default' : 'secondary'}
                              className="text-xs flex items-center gap-1"
                            >
                              {isVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                              {isVisible ? t('trainers.visible') : t('trainers.hidden')}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between text-sm">
                        {trainer.trainer_profile?.hourly_rate && (
                          <span className="font-semibold text-primary">
                            €{trainer.trainer_profile.hourly_rate}/hour
                          </span>
                        )}
                        {trainer.trainer_profile?.experience_years && (
                          <span className="text-muted-foreground">
                            {trainer.trainer_profile.experience_years}y exp.
                          </span>
                        )}
                      </div>

                      {trainer.trainer_profile?.specializations?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {trainer.trainer_profile.specializations.slice(0, 3).map((spec: string) => (
                            <Badge key={spec} variant="outline" className="text-xs">
                              {spec}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {/* Visibility Toggle */}
                      <div className="pt-2 border-t">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center justify-between">
                                <Label
                                  htmlFor={`visibility-${trainer.id}`}
                                  className={`text-sm ${!hasName ? 'text-muted-foreground' : ''}`}
                                >
                                  {t('trainers.showOnAcademyPage')}
                                </Label>
                                <Switch
                                  id={`visibility-${trainer.id}`}
                                  checked={isVisible}
                                  onCheckedChange={(checked) =>
                                    handleVisibilityToggle(trainer.id, checked, hasName)
                                  }
                                  disabled={updatingVisibility === trainer.id || (!hasName && !isVisible)}
                                />
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {hasName ? t('trainers.visibilityHint') : t('trainers.incompleteProfile')}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>

                      <div className="flex flex-wrap gap-2 pt-2">
                        {trainer.trainer_profile?.user_id && (
                          <EditAcademyTrainerDialog
                            trainerId={trainer.trainer_profile.id}
                            userId={trainer.trainer_profile.user_id}
                            trainerName={trainer.profile?.full_name || 'Trainer'}
                            onTrainerUpdated={fetchData}
                          />
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(localizePath(`/trainer/${trainer.trainer_profile?.slug || trainer.trainer_profile?.id}`))}
                        >
                          <ExternalLink className="h-4 w-4 mr-2" />
                          {t('trainers.viewProfile', 'Profile')}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="destructive" size="sm">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('trainers.removeTitle')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('trainers.removeDescription')}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleRemoveTrainer(trainer.id)}>
                                {t('trainers.remove')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="pending">
          {pendingInvitations.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Clock className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">{t('trainerInvitation.noPending')}</h3>
                <p className="text-muted-foreground">{t('trainerInvitation.noPendingDescription')}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {pendingInvitations.map((invitation) => (
                <Card key={invitation.id}>
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{invitation.trainer_email}</p>
                        <p className="text-sm text-muted-foreground">
                          {t('trainerInvitation.sentAgo', {
                            time: formatDistanceToNow(new Date(invitation.created_at), { addSuffix: true }),
                          })}
                        </p>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm">
                            {t('trainerInvitation.cancel')}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('trainerInvitation.cancelTitle')}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t('trainerInvitation.cancelDescription')}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleCancelInvitation(invitation.id)}>
                              {t('trainerInvitation.confirmCancel')}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
