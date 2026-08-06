import { useState, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { AlertCircle, Bell, FileText, ListChecks, Loader2, Lock, MessageSquare, Settings, Trash2, UserPlus } from 'lucide-react';
import { Globe, Clock } from 'lucide-react';
import { COMMON_TIMEZONES } from '@/lib/timezones';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import LinkExtension from '@tiptap/extension-link';
import UnderlineExtension from '@tiptap/extension-underline';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AppPage } from '@/components/ui/app-page';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyManagers, addAcademyManager, removeAcademyManager, getAcademyTrainersForManagerPicker } from '@/lib/academy';
import {
  connectAcademyMollie,
  checkAcademyConnectStatus,
  disconnectAcademyMollie,
  type AcademyConnectStatus,
} from '@/lib/academyPayments';
import { AcademyMolliePaymentCard } from '@/components/academy/AcademyMolliePaymentCard';
import { RichTextEditor } from '@/components/ui/rich-text-editor';
import { normalizeRichTextHtml } from '@/lib/richText';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { AcademyPriceDisplayCard } from '@/components/academy/AcademyPriceDisplayCard';

import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { BOOKING_CUTOFF_PRESETS, formatCutoffMinutes } from '@/lib/bookingCutoff';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';

export default function AcademySettings() {
  const { t, i18n } = useTranslation('academy');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { activeAcademy } = useAcademyContext();
  const { user, session, loading: authLoading } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [managers, setManagers] = useState<any[]>([]);
  const [availableTrainers, setAvailableTrainers] = useState<{ userId: string; fullName: string; email: string; avatarUrl: string | null }[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>('');
  const [addingManager, setAddingManager] = useState(false);
  const [removingManagerId, setRemovingManagerId] = useState<string | null>(null);
  const [managerToRemove, setManagerToRemove] = useState<string | null>(null);
  
  // Mollie Connect state
  const [connectStatus, setConnectStatus] = useState<AcademyConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [savingTerms, setSavingTerms] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [savingWelcome, setSavingWelcome] = useState(false);
  const [academyTimezone, setAcademyTimezone] = useState('Europe/Amsterdam');
  const [updatingTimezone, setUpdatingTimezone] = useState(false);
  const [minNotice, setMinNotice] = useState(0);
  const [updatingMinNotice, setUpdatingMinNotice] = useState(false);
  const [warningMaxRatingSpread, setWarningMaxRatingSpread] = useState<string>('');
  const [warningMaxAgeDiffYears, setWarningMaxAgeDiffYears] = useState<string>('');
  const [savingWarnings, setSavingWarnings] = useState(false);
  const [rebookRules, setRebookRules] = useState('');
  const [savingRebookRules, setSavingRebookRules] = useState(false);
  const termsEditor = useEditor({
    extensions: [
      StarterKit,
      LinkExtension.configure({ openOnClick: false }),
      UnderlineExtension,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none min-h-[200px] p-4 focus:outline-none',
      },
    },
  });

  // Determine if current user is an owner
  const isOwner = useMemo(() => {
    if (!user || !managers.length) return false;
    return managers.some(m => m.user_id === user.id && m.role === 'owner');
  }, [managers, user]);

  // Filter trainers who are not already managers
  const filteredTrainers = useMemo(() => {
    const managerUserIds = new Set(managers.map(m => m.user_id));
    return availableTrainers.filter(t => !managerUserIds.has(t.userId));
  }, [availableTrainers, managers]);

  const fetchManagersAndTrainers = async () => {
    if (!activeAcademy) return;
    const [managersData, trainersData] = await Promise.all([
      getAcademyManagers(activeAcademy.id),
      getAcademyTrainersForManagerPicker(activeAcademy.id),
    ]);
    setManagers(managersData);
    setAvailableTrainers(trainersData);
  };

  useEffect(() => {
    async function fetchData() {
      if (!activeAcademy) return;

      await fetchManagersAndTrainers();

      if (authLoading || !accessToken) {
        setConnectStatus(null);
        setCheckingStatus(true);
        return;
      }

      setCheckingStatus(true);
      try {
        const status = await checkAcademyConnectStatus(activeAcademy.id, accessToken);
        setConnectStatus(status);
      } catch (e) {
        logger.error("Error checking connect status", e as Error, { component: "AcademySettings", academyId: activeAcademy?.id });
      } finally {
        setCheckingStatus(false);
      }
    }
    fetchData();
  }, [activeAcademy, authLoading, accessToken]);

  // Load terms into editor when academy changes
  useEffect(() => {
    if (!termsEditor || !activeAcademy) return;
    const loadTermsAndWelcome = async () => {
      const { data } = await supabase
        .from('academy_profiles')
        .select('general_terms, welcome_message, timezone, warning_max_rating_spread, warning_max_age_diff_years, player_booking_min_notice_minutes')
        .eq('id', activeAcademy.id)
        .maybeSingle();
      if (data?.general_terms) {
        termsEditor.commands.setContent(data.general_terms as string);
      }
      if (data?.welcome_message) {
        setWelcomeMessage(data.welcome_message);
      }
      if ((data as any)?.timezone) {
        setAcademyTimezone((data as any).timezone);
        setMinNotice((data as { player_booking_min_notice_minutes?: number | null }).player_booking_min_notice_minutes ?? 0);
      }
      if ((data as any)?.warning_max_rating_spread != null) {
        setWarningMaxRatingSpread(String((data as any).warning_max_rating_spread));
      }
      if ((data as any)?.warning_max_age_diff_years != null) {
        setWarningMaxAgeDiffYears(String((data as any).warning_max_age_diff_years));
      }
    };
    loadTermsAndWelcome();
  }, [activeAcademy, termsEditor]);

  // Load the academy's default rebooking rules. Read separately + tolerantly so a not-yet-applied
  // migration (the rebook_rules column may be absent) cannot break the rest of the settings load.
  useEffect(() => {
    if (!activeAcademy) return;
    let cancelled = false;
    const loadRebookRules = async () => {
      try {
        const { data, error } = await supabase
          .from('academy_profiles')
          .select('rebook_rules')
          .eq('id', activeAcademy.id)
          .maybeSingle();
        if (error) throw error;
        if (!cancelled && data?.rebook_rules) {
          setRebookRules(data.rebook_rules);
        }
      } catch {
        // Column not present yet (deploy order) — degrade to blank.
      }
    };
    loadRebookRules();
    return () => {
      cancelled = true;
    };
  }, [activeAcademy]);

  const handleSaveTerms = async () => {
    if (!activeAcademy || !termsEditor) return;
    setSavingTerms(true);
    try {
      const content = termsEditor.getHTML();
      const isEmpty = termsEditor.isEmpty;
      const { error } = await supabase
        .from('academy_profiles')
        .update({ general_terms: isEmpty ? null : content } as any)
        .eq('id', activeAcademy.id);
      if (error) throw error;
      toast({ title: t('terms.saved', 'Terms saved successfully') });
    } catch (error: any) {
      logger.error('Error saving academy terms', error, { component: 'AcademySettings' });
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('terms.saveError', 'Failed to save terms')), variant: 'destructive' });
    } finally {
      setSavingTerms(false);
    }
  };

  const handleSaveWelcomeMessage = async () => {
    if (!activeAcademy) return;
    setSavingWelcome(true);
    try {
      const { error } = await supabase
        .from('academy_profiles')
        .update({ welcome_message: welcomeMessage.trim() || null } as any)
        .eq('id', activeAcademy.id);
      if (error) throw error;
      toast({ title: t('welcomeMessage.saved') });
    } catch (error: any) {
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('welcomeMessage.saveError', 'Failed to save welcome message')), variant: 'destructive' });
    } finally {
      setSavingWelcome(false);
    }
  };

  const handleSaveRebookRules = async () => {
    if (!activeAcademy) return;
    setSavingRebookRules(true);
    try {
      const { error } = await supabase
        .from('academy_profiles')
        .update({ rebook_rules: normalizeRichTextHtml(rebookRules) })
        .eq('id', activeAcademy.id);
      if (error) throw error;
      toast({ title: t('rebookRules.saved', 'Rebooking rules saved') });
    } catch (error) {
      logger.error('Error saving rebooking rules', error instanceof Error ? error : new Error(String(error)), { component: 'AcademySettings' });
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('rebookRules.saveError', 'Failed to save rebooking rules')), variant: 'destructive' });
    } finally {
      setSavingRebookRules(false);
    }
  };

  // Handle Mollie redirect callbacks
  useEffect(() => {
    if (searchParams.get("mollie_success") === "true" && activeAcademy && accessToken) {
      toast({
        title: t("settings.mollieConnectSuccess", "Payment Account Connected"),
        description: t("settings.mollieConnectSuccessDescription", "Your payment account has been connected successfully."),
      });
      checkAcademyConnectStatus(activeAcademy.id, accessToken).then(setConnectStatus).catch((e) => logger.error("Error refreshing connect status", e as Error, { component: "AcademySettings" }));
    } else if (searchParams.get("mollie_refresh") === "true") {
      toast({
        title: t("settings.mollieConnectRefresh", "Complete Setup"),
        description: t("settings.mollieConnectRefreshDescription", "Please complete your payment account setup."),
        variant: "destructive",
      });
    }
  }, [searchParams, activeAcademy, accessToken, toast, t]);

  const handleConnectMollie = async () => {
    if (!activeAcademy || !accessToken) return;

    setConnectLoading(true);
    try {
      const url = await connectAcademyMollie(activeAcademy.id, accessToken);
      window.open(url, "_blank");
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: getFriendlyErrorMessage(error, t("settings.mollieConnectError", "Failed to connect your payment account. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setConnectLoading(false);
    }
  };

  const handleRefreshStatus = async () => {
    if (!activeAcademy || !accessToken) return;

    setCheckingStatus(true);
    try {
      const status = await checkAcademyConnectStatus(activeAcademy.id, accessToken);
      setConnectStatus(status);
      toast({
        title: t("settings.statusRefreshed", "Status Refreshed"),
        description: t("settings.statusRefreshedDescription", "Connection status has been updated."),
      });
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: getFriendlyErrorMessage(error, t("settings.statusRefreshError", "Failed to refresh connection status")),
        variant: "destructive",
      });
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleDisconnectMollie = async () => {
    if (!activeAcademy || !accessToken) return;
    try {
      await disconnectAcademyMollie(activeAcademy.id, accessToken);
      setConnectStatus({
        connected: false,
        paymentReady: false,
        paymentUnavailableReason: null,
        hasAccessToken: false,
        hasRefreshToken: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingComplete: false,
      });
      toast({
        title: t("settings.disconnectSuccess", "Payment account disconnected"),
        description: t(
          "settings.disconnectSuccessDescription",
          "You can connect Mollie again when you are ready.",
        ),
      });
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: getFriendlyErrorMessage(error, t("settings.disconnectError", "Failed to disconnect your payment account")),
        variant: "destructive",
      });
      throw error;
    }
  };

  const handleAddManager = async () => {
    if (!activeAcademy || !selectedTrainerId) return;
    setAddingManager(true);
    try {
      const result = await addAcademyManager(activeAcademy.id, selectedTrainerId);
      if (!result.success) throw new Error(result.error);
      toast({ title: t('managers.added', 'Manager added successfully') });
      setSelectedTrainerId('');
      await fetchManagersAndTrainers();
    } catch (error: any) {
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('managers.addError', 'Failed to add manager')), variant: 'destructive' });
    } finally {
      setAddingManager(false);
    }
  };

  const handleRemoveManager = (managerId: string) => {
    setManagerToRemove(managerId);
  };

  const confirmRemoveManager = async () => {
    if (!managerToRemove || removingManagerId) return;
    setRemovingManagerId(managerToRemove);
    try {
      const result = await removeAcademyManager(managerToRemove);
      if (!result.success) throw new Error(result.error);
      toast({ title: t('managers.removed', 'Manager removed') });
      await fetchManagersAndTrainers();
    } catch (error: any) {
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('managers.removeError', 'Failed to remove manager')), variant: 'destructive' });
    } finally {
      setRemovingManagerId(null);
      setManagerToRemove(null);
    }
  };

  if (!activeAcademy) {
    return null;
  }

  return (
    <AppPage width="narrow" className="space-y-6">
        <AcademyMolliePaymentCard
          connectStatus={connectStatus}
          checkingStatus={checkingStatus || authLoading}
          connectLoading={connectLoading}
          sessionMissing={!authLoading && !accessToken}
          onConnect={handleConnectMollie}
          onRefresh={handleRefreshStatus}
          onDisconnect={handleDisconnectMollie}
        />

        <AcademyPriceDisplayCard academyId={activeAcademy.id} />

        {/* Warnings */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">
                {t("settings.warnings", "Warnings")}
              </CardTitle>
            </div>
            <CardDescription>
              {t("settings.warningsDescription", "Set thresholds for when to show warning icons on the calendar overview when players in the same slot have big differences.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("settings.maxRatingSpread", "Max rating spread")}</label>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={warningMaxRatingSpread}
                  onChange={(e) => setWarningMaxRatingSpread(e.target.value)}
                  placeholder={t("settings.maxRatingSpreadPlaceholder", "e.g. 2.0")}
                />
                <p className="text-xs text-muted-foreground">{t("settings.maxRatingSpreadHelp", "Show warning when the skill rating difference between players exceeds this value. Leave empty to disable.")}</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("settings.maxAgeDiff", "Max age difference (years)")}</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={warningMaxAgeDiffYears}
                  onChange={(e) => setWarningMaxAgeDiffYears(e.target.value)}
                  placeholder={t("settings.maxAgeDiffPlaceholder", "e.g. 5")}
                />
                <p className="text-xs text-muted-foreground">{t("settings.maxAgeDiffHelp", "Show warning when the age difference between players exceeds this many years. Leave empty to disable.")}</p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                disabled={savingWarnings}
                onClick={async () => {
                  if (!activeAcademy) return;
                  setSavingWarnings(true);
                  try {
                    const { error } = await supabase
                      .from('academy_profiles')
                      .update({
                        warning_max_rating_spread: warningMaxRatingSpread ? Number(warningMaxRatingSpread) : null,
                        warning_max_age_diff_years: warningMaxAgeDiffYears ? Number(warningMaxAgeDiffYears) : null,
                      } as any)
                      .eq('id', activeAcademy.id);
                    if (error) throw error;
                    toast({ title: t('settings.warningsSaved', 'Warning settings saved') });
                  } catch (error: any) {
                    toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('settings.warningsSaveError', 'Failed to save warning settings')), variant: 'destructive' });
                  } finally {
                    setSavingWarnings(false);
                  }
                }}
              >
                {savingWarnings && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('common.save', 'Save Changes')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* General Terms */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">
                {t("terms.title", "General Terms")}
              </CardTitle>
            </div>
            <CardDescription>
              {t("terms.description", "Terms players must accept before booking lessons with your trainers.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border rounded-lg overflow-hidden">
              <EditorContent editor={termsEditor} />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveTerms} disabled={savingTerms}>
                {savingTerms && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('common.save', 'Save Changes')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Welcome Message */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">
                {t("welcomeMessage.title")}
              </CardTitle>
            </div>
            <CardDescription>
              {t("welcomeMessage.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={welcomeMessage}
              onChange={(e) => setWelcomeMessage(e.target.value)}
              placeholder={t("welcomeMessage.placeholder")}
              rows={4}
              maxLength={1000}
            />
            <div className="flex justify-end">
              <Button onClick={handleSaveWelcomeMessage} disabled={savingWelcome}>
                {savingWelcome && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('common.save', 'Save Changes')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Default rebooking rules */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ListChecks className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">
                {t('rebookRules.title', 'Rebooking rules')}
              </CardTitle>
            </div>
            <CardDescription>
              {t('rebookRules.description', 'Rules players see in the rebooking invitation and must agree to before paying. Used as the default for new rebookings.')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <RichTextEditor
              value={rebookRules}
              onChange={setRebookRules}
              placeholder={t('rebookRules.placeholder', 'e.g. Payment within 7 days. No refunds after the cycle start date.')}
            />
            <div className="flex justify-end">
              <Button onClick={handleSaveRebookRules} disabled={savingRebookRules}>
                {savingRebookRules && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('common.save', 'Save Changes')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Managers */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              {t('managers.title')}
            </CardTitle>
            <CardDescription>{t('managers.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {managers.map((manager) => (
                <div key={manager.id} className="flex items-center justify-between p-3 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage src={manager.profile?.avatar_url} />
                      <AvatarFallback>
                        {manager.profile?.full_name?.charAt(0) || 'U'}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{manager.profile?.full_name || t('common:unknown')}</p>
                      <p className="text-sm text-muted-foreground">{manager.profile?.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={manager.role === 'owner' ? 'default' : 'secondary'}>
                      {manager.role === 'owner' ? t('managers.owner') : t('managers.manager')}
                    </Badge>
                    {isOwner && manager.role !== 'owner' && (
                      <Button
                        variant="ghost"
                        size="icon" aria-label={t('common:delete', 'Delete')}
                        onClick={() => handleRemoveManager(manager.id)}
                        disabled={removingManagerId === manager.id}
                      >
                        {removingManagerId === manager.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4 text-destructive" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              
              {managers.length === 0 && (
                <p className="text-center text-muted-foreground py-4">
                  {t('managers.noManagers', 'No managers found')}
                </p>
              )}

              {/* Add Manager */}
              {isOwner && (
                <div className="pt-2 border-t">
                  {filteredTrainers.length > 0 ? (
                    <div className="flex items-center gap-2">
                      <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                        <SelectTrigger className="flex-1">
                          <SelectValue placeholder={t('managers.selectTrainer', 'Select a trainer...')} />
                        </SelectTrigger>
                        <SelectContent>
                          {filteredTrainers.map((trainer) => (
                            <SelectItem key={trainer.userId} value={trainer.userId}>
                              <div className="flex items-center gap-2">
                                <Avatar className="h-6 w-6">
                                  <AvatarImage src={trainer.avatarUrl || undefined} />
                                  <AvatarFallback className="text-xs">
                                    {trainer.fullName?.charAt(0) || 'T'}
                                  </AvatarFallback>
                                </Avatar>
                                <span>{trainer.fullName || trainer.email}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button onClick={handleAddManager} disabled={!selectedTrainerId || addingManager}>
                        {addingManager ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <UserPlus className="h-4 w-4" />
                        )}
                        {t('managers.addManager', 'Add Manager')}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('managers.noTrainersAvailable', 'No trainers available to add')}
                    </p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Language Setting */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Globe className="h-5 w-5 text-indigo-600" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">{t("settings.language", "Language")}</CardTitle>
                <CardDescription>{t("settings.languageDescription", "Choose your preferred language for the app")}</CardDescription>
              </div>
              <Select
                value={i18n.language}
                onValueChange={async (value) => {
                  i18n.changeLanguage(value);
                  if (user) {
                    await supabase.from('profiles').update({ preferred_language: value } as any).eq('user_id', user.id);
                  }
                }}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nl">🇳🇱 Nederlands</SelectItem>
                  <SelectItem value="en">🇬🇧 English</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
        </Card>

        {/* Notification preferences — the manager's own. The route existed under all three role
            layouts, but this hub never linked it, so academy managers had no way to reach their
            notification settings (player + trainer hubs both link theirs). */}
        <Card
          className={`${flushOnMobileCardClass()} cursor-pointer transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          onClick={() => navigate('/app/academy/settings/notifications')}
          role="link"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              navigate('/app/academy/settings/notifications');
            }
          }}
          data-testid="academy-notifications-card"
        >
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <Bell className="h-5 w-5 text-orange-600" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">{t('settings.notifications', 'Notifications')}</CardTitle>
                <CardDescription>
                  {t('settings.notificationsDescription', 'Manage your notification preferences')}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Player booking cutoff */}
        <Card className={flushOnMobileCardClass()} data-testid="academy-min-notice-card">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Lock className="h-5 w-5 text-amber-600" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">
                  {t('settings.minNotice', 'Minimum notice for player bookings')}
                </CardTitle>
                <CardDescription>
                  {t('settings.minNoticeDescription',
                    'Players cannot book sessions less than this long before the start time. Staff can still add bookings manually.')}
                </CardDescription>
              </div>
              <Select
                value={String(minNotice)}
                onValueChange={async (value) => {
                  if (!activeAcademy) return;
                  const minutes = Number(value);
                  setUpdatingMinNotice(true);
                  try {
                    const { error } = await supabase
                      .from('academy_profiles')
                      .update({ player_booking_min_notice_minutes: minutes })
                      .eq('id', activeAcademy.id);
                    if (error) throw error;
                    setMinNotice(minutes);
                    toast({ title: t('settings.minNoticeSaved', 'Booking cutoff updated') });
                  } catch (error) {
                    // No `as any` / `error: any` here, unlike the neighbouring timezone card:
                    // the column is in the generated types now, and the suppression ratchet for
                    // this file is at its existing count — new code should not spend it.
                    toast({
                      title: t('common.error'),
                      description: getFriendlyErrorMessage(error, t('settings.minNoticeSaveError', 'Failed to update the booking cutoff')),
                      variant: 'destructive',
                    });
                  } finally {
                    setUpdatingMinNotice(false);
                  }
                }}
                disabled={updatingMinNotice}
              >
                <SelectTrigger className="w-[240px]" data-testid="academy-min-notice-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOOKING_CUTOFF_PRESETS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {formatCutoffMinutes(m, (k, fb, o) => t(k, fb, o))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
        </Card>

        {/* Timezone Setting */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-sky-500/10">
                <Clock className="h-5 w-5 text-sky-600" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg">{t('settings.timezone', 'Timezone')}</CardTitle>
                <CardDescription>{t('settings.timezoneDescription', 'Set the timezone used for scheduling and displaying lesson times')}</CardDescription>
              </div>
              <Select
                value={academyTimezone}
                onValueChange={async (value) => {
                  if (!activeAcademy) return;
                  setUpdatingTimezone(true);
                  try {
                    const { error } = await supabase
                      .from('academy_profiles')
                      .update({ timezone: value } as any)
                      .eq('id', activeAcademy.id);
                    if (error) throw error;
                    setAcademyTimezone(value);
                    toast({ title: t('settings.timezoneSaved', 'Timezone updated') });
                  } catch (error: any) {
                    toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('settings.timezoneSaveError', 'Failed to update timezone')), variant: 'destructive' });
                  } finally {
                    setUpdatingTimezone(false);
                  }
                }}
                disabled={updatingTimezone}
              >
                <SelectTrigger className="w-[240px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_TIMEZONES.map(tz => (
                    <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
        </Card>

        {/* N3: academy-wide notification limits (manager controls; distinct from the
            per-account notification settings card the N1 branch adds — kept separate so the
            two merge cleanly). */}
        <Card
          className={flushOnMobileCardClass('cursor-pointer transition-colors hover:bg-muted/50')}
          role="link"
          tabIndex={0}
          data-testid="academy-notif-controls-card"
          onClick={() => { window.location.assign('/app/academy/settings/notification-controls'); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              window.location.assign('/app/academy/settings/notification-controls');
            }
          }}
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {t('academyNotifControls.cardTitle', 'Notification limits')}
            </CardTitle>
            <CardDescription>
              {t('academyNotifControls.cardDesc', 'Reduce or stop optional notifications for people at your academy. Every change is audited and visible to affected players.')}
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Danger Zone */}
        <div className="border-t border-destructive/20 pt-6">
          <h3 className="mb-4 text-lg font-semibold text-destructive">{t('settings.dangerZone', 'Danger Zone')}</h3>
          <DeleteAccountDialog />
        </div>

        <ConfirmDeleteDialog
          open={!!managerToRemove}
          onOpenChange={(next) => { if (!next) setManagerToRemove(null); }}
          title={t('managers.confirmRemoveTitle', 'Remove manager?')}
          description={t('managers.confirmRemove', 'Are you sure you want to remove this manager?')}
          confirmLabel={t('managers.remove', 'Remove')}
          cancelLabel={t('common:cancel', 'Cancel')}
          loading={!!removingManagerId}
          onConfirm={() => { void confirmRemoveManager(); }}
        />
    </AppPage>
  );
}
