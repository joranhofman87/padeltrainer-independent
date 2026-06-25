import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { Users, ExternalLink, Clock, UserPlus, MapPin, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { compactDataTableClass, DataTableCard } from '@/components/ui/data-table';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { EmptyState } from '@/components/ui/empty-state';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { logger } from '@/lib/logger';
import { ListPageShell, ListPageState } from '@/components/ui/list-page-shell';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
  cancelAcademyInvitation,
  canUserAddSelfAsTrainer,
  addSelfAsAcademyTrainer,
  getAcademyLocations,
} from '@/lib/academy';
import { InviteAcademyTrainerDialog } from '@/components/academy/InviteAcademyTrainerDialog';
import { CreateAcademyTrainerDialog } from '@/components/academy/CreateAcademyTrainerDialog';

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
  const [_academyLocations, setAcademyLocations] = useState<any[]>([]);
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
      const [trainersData, invitationsData, locationsData] = await Promise.all([
        getAcademyTrainersWithProfiles(activeAcademy.id),
        getAcademyPendingInvitations(activeAcademy.id),
        getAcademyLocations(activeAcademy.id),
      ]);
      setTrainers(trainersData);
      setPendingInvitations(invitationsData);
      setAcademyLocations(locationsData);

      // Check if current user can add themselves as a trainer
      if (user) {
        const selfCheck = await canUserAddSelfAsTrainer(user.id, activeAcademy.id);
        setCanAddSelf(selfCheck);
      }
    } catch (error) {
      logger.error('Error fetching data', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyTrainers' });
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
      toast.error(t('trainers.visibilityUpdateFailed', 'Failed to update visibility'));
    }
    setUpdatingVisibility(null);
  };

  const handleCancelInvitation = async (invitationId: string) => {
    const success = await cancelAcademyInvitation(invitationId);
    if (success) {
      setPendingInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      toast.success(t('trainerInvitation.canceled'));
    } else {
      toast.error(t('trainerInvitation.cancelFailed', 'Failed to cancel invitation'));
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

  const activeTrainers = trainers.filter((t) => t.status === 'active');

  return (
    <ListPageShell
      isLoading={loading}
      title={t('trainers.title')}
      description={t('trainers.description')}
      actions={
        activeAcademy && user && profile ? (
          <div className="flex items-center gap-2">
            <CreateAcademyTrainerDialog
              academyProfileId={activeAcademy.id}
              onTrainerCreated={fetchData}
            />
            <InviteAcademyTrainerDialog
              academyProfileId={activeAcademy.id}
              academyName={activeAcademy.name}
              inviterId={user.id}
              inviterName={profile.full_name || t('badge')}
              onInviteSent={fetchData}
            />
          </div>
        ) : undefined
      }
      headerAfter={
        <p className="mt-2 text-xs text-muted-foreground">
          {t(
            'trainers.createOrInviteHint',
            'Create Trainer: you set up the account and share the login details yourself. Invite Trainer: the trainer receives an email and signs up on their own.'
          )}
        </p>
      }
    >

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
          <ListPageState
            isEmpty={activeTrainers.length === 0}
            empty={
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <EmptyState
                  icon={Users}
                  title={t('trainers.empty')}
                  description={t('trainers.emptyDescription')}
                />
              </Card>
            }
          >
            <DataTableCard
              testId="academy-trainers-table-scroll"
              className={flushOnMobileCardClass()}
              mobile={
                <div className="md:hidden divide-y divide-border/60">
                  {activeTrainers.map((trainer) => {
                    const hasName = !!trainer.profile?.full_name;
                    const isVisible = trainer.show_on_academy_page;

                    return (
                      <div
                        key={trainer.id}
                        className="py-3 space-y-3 first:pt-1"
                      >
                        <div className="flex items-center justify-between">
                          <div
                            className="flex items-center gap-3 cursor-pointer hover:opacity-80 min-w-0 flex-1"
                            onClick={() => navigate(`/app/academy/trainers/${trainer.id}`)}
                          >
                            <Avatar className="h-9 w-9 shrink-0">
                              <AvatarImage src={trainer.profile?.avatar_url || ''} alt={trainer.profile?.full_name || ''} />
                              <AvatarFallback className="text-xs">
                                {getInitials(trainer.profile?.full_name)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="font-medium truncate">
                              {trainer.profile?.full_name || t('common:trainer')}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Switch
                              checked={isVisible}
                              onCheckedChange={(checked) =>
                                handleVisibilityToggle(trainer.id, checked, hasName)
                              }
                              disabled={updatingVisibility === trainer.id || (!hasName && !isVisible)}
                            />
                            <Button
                              variant="ghost"
                              size="icon" aria-label={t('common:next')}
                              className="h-8 w-8"
                              onClick={() => navigate(`/app/academy/trainers/${trainer.id}`)}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        {trainer.locations && trainer.locations.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {trainer.locations.map((loc: any) => (
                              <Badge key={loc.id} variant="secondary" className="text-xs">
                                <MapPin className="h-3 w-3 mr-1" />
                                {loc.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              }
            >
              <Table className={compactDataTableClass}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[250px]">{t('common:name', 'Name')}</TableHead>
                     <TableHead>{t('common:locations.title', 'Locations')}</TableHead>
                     <TableHead className="text-center">{t('trainers.showOnAcademyPage', 'Visible')}</TableHead>
                     <TableHead className="text-right w-[100px]">{t('common:actions', 'Actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeTrainers.map((trainer) => {
                    const hasName = !!trainer.profile?.full_name;
                    const isVisible = trainer.show_on_academy_page;

                    return (
                      <TableRow key={trainer.id}>
                         <TableCell>
                          <div
                            className="flex items-center gap-3 cursor-pointer hover:opacity-80"
                            onClick={() => navigate(`/app/academy/trainers/${trainer.id}`)}
                          >
                            <Avatar className="h-9 w-9">
                              <AvatarImage src={trainer.profile?.avatar_url || ''} alt={trainer.profile?.full_name || ''} />
                              <AvatarFallback className="text-xs">
                                {getInitials(trainer.profile?.full_name)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="font-medium truncate">
                              {trainer.profile?.full_name || t('common:trainer')}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {trainer.locations && trainer.locations.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {trainer.locations.map((loc: any) => (
                                <Badge key={loc.id} variant="secondary" className="text-xs">
                                  <MapPin className="h-3 w-3 mr-1" />
                                  {loc.name}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-sm">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex justify-center">
                                  <Switch
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
                                  {hasName
                                    ? isVisible
                                      ? t('trainers.visibilityHint')
                                      : t('trainers.hidden')
                                    : t('trainers.incompleteProfile')}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon" aria-label={t('trainers.openInNewTab', 'Open in new tab')}
                                    onClick={() =>
                                      navigate(
                                        localizePath(
                                          `/trainer/${trainer.trainer_profile?.slug || trainer.trainer_profile?.id}`
                                        )
                                      )
                                    }
                                  >
                                    <ExternalLink className="h-4 w-4" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>{t('trainers.viewProfile', 'View public profile')}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <Button
                              variant="ghost"
                              size="icon" aria-label={t('common:next')}
                              onClick={() => navigate(`/app/academy/trainers/${trainer.id}`)}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </DataTableCard>
          </ListPageState>
        </TabsContent>

        <TabsContent value="pending">
          <ListPageState
            isEmpty={pendingInvitations.length === 0}
            empty={
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <EmptyState
                  icon={Clock}
                  title={t('trainerInvitation.noPending')}
                  description={t('trainerInvitation.noPendingDescription')}
                />
              </Card>
            }
          >
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
          </ListPageState>
        </TabsContent>
      </Tabs>
    </ListPageShell>
  );
}
