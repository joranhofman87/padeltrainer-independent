import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { 
  Settings, 
  CreditCard, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink, 
  Wallet,
  Loader2,
  FileText,
  UserPlus,
  Trash2,
  MessageSquare
} from 'lucide-react';
import { Globe } from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import LinkExtension from '@tiptap/extension-link';
import UnderlineExtension from '@tiptap/extension-underline';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyManagers, addAcademyManager, removeAcademyManager, getAcademyTrainersForManagerPicker } from '@/lib/academy';
import { 
  connectAcademyMollie, 
  checkAcademyConnectStatus,
  type AcademyConnectStatus 
} from '@/lib/academyPayments';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { AcademyInvoiceSettingsCard } from '@/components/academy/AcademyInvoiceSettingsCard';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';

export default function AcademySettings() {
  const { t, i18n } = useTranslation('academy');
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { activeAcademy } = useAcademyContext();
  const { user } = useAuth();
  const [managers, setManagers] = useState<any[]>([]);
  const [availableTrainers, setAvailableTrainers] = useState<{ userId: string; fullName: string; email: string; avatarUrl: string | null }[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>('');
  const [addingManager, setAddingManager] = useState(false);
  const [removingManagerId, setRemovingManagerId] = useState<string | null>(null);
  
  // Mollie Connect state
  const [connectStatus, setConnectStatus] = useState<AcademyConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [savingWelcome, setSavingWelcome] = useState(false);
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
      
      // Check Mollie connect status
      setCheckingStatus(true);
      try {
        const status = await checkAcademyConnectStatus(activeAcademy.id);
        setConnectStatus(status);
      } catch (e) {
        logger.error("Error checking connect status", e as Error, { component: "AcademySettings", academyId: activeAcademy?.id });
      } finally {
        setCheckingStatus(false);
      }
    }
    fetchData();
  }, [activeAcademy]);

  // Load terms into editor when academy changes
  useEffect(() => {
    if (!termsEditor || !activeAcademy) return;
    const loadTermsAndWelcome = async () => {
      const { data } = await supabase
        .from('academy_profiles')
        .select('general_terms, welcome_message')
        .eq('id', activeAcademy.id)
        .maybeSingle();
      if (data?.general_terms) {
        termsEditor.commands.setContent(data.general_terms as string);
      }
      if (data?.welcome_message) {
        setWelcomeMessage(data.welcome_message);
      }
    };
    loadTermsAndWelcome();
  }, [activeAcademy, termsEditor]);

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
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
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
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } finally {
      setSavingWelcome(false);
    }
  };

  // Handle Mollie redirect callbacks
  useEffect(() => {
    if (searchParams.get("mollie_success") === "true" && activeAcademy) {
      toast({
        title: t("settings.mollieConnectSuccess", "Payment Account Connected"),
        description: t("settings.mollieConnectSuccessDescription", "Your payment account has been connected successfully."),
      });
      checkAcademyConnectStatus(activeAcademy.id).then(setConnectStatus).catch((e) => logger.error("Error refreshing connect status", e as Error, { component: "AcademySettings" }));
    } else if (searchParams.get("mollie_refresh") === "true") {
      toast({
        title: t("settings.mollieConnectRefresh", "Complete Setup"),
        description: t("settings.mollieConnectRefreshDescription", "Please complete your payment account setup."),
        variant: "destructive",
      });
    }
  }, [searchParams, activeAcademy, toast, t]);

  const handleConnectMollie = async () => {
    if (!activeAcademy) return;
    
    setConnectLoading(true);
    try {
      const url = await connectAcademyMollie(activeAcademy.id);
      window.open(url, "_blank");
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setConnectLoading(false);
    }
  };

  const handleRefreshStatus = async () => {
    if (!activeAcademy) return;
    
    setCheckingStatus(true);
    try {
      const status = await checkAcademyConnectStatus(activeAcademy.id);
      setConnectStatus(status);
      toast({
        title: t("settings.statusRefreshed", "Status Refreshed"),
        description: t("settings.statusRefreshedDescription", "Connection status has been updated."),
      });
    } catch (error: any) {
      toast({
        title: t("common.error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setCheckingStatus(false);
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
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } finally {
      setAddingManager(false);
    }
  };

  const handleRemoveManager = async (managerId: string) => {
    if (!confirm(t('managers.confirmRemove', 'Are you sure you want to remove this manager?'))) return;
    setRemovingManagerId(managerId);
    try {
      const result = await removeAcademyManager(managerId);
      if (!result.success) throw new Error(result.error);
      toast({ title: t('managers.removed', 'Manager removed') });
      await fetchManagersAndTrainers();
    } catch (error: any) {
      toast({ title: t('common.error'), description: error.message, variant: 'destructive' });
    } finally {
      setRemovingManagerId(null);
    }
  };

  if (!activeAcademy) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <div className="space-y-6">
        {/* Payment Connect Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">
                {t("settings.mollieConnect", "Payment Setup")}
              </CardTitle>
            </div>
            <CardDescription>
              {t("settings.mollieConnectDescription", "Connect your payment account to receive payments from lesson bookings.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {checkingStatus ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("settings.checkingStatus", "Checking status...")}
              </div>
            ) : connectStatus?.connected ? (
              <>
                {/* Connection Status */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    {connectStatus.chargesEnabled ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-amber-500" />
                    )}
                    <span className="font-medium">
                      {connectStatus.chargesEnabled
                        ? t("settings.paymentsEnabled", "Payments Enabled")
                        : t("settings.paymentsNotEnabled", "Payments Not Yet Enabled")}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {connectStatus.payoutsEnabled ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-amber-500" />
                    )}
                    <span className="font-medium">
                      {connectStatus.payoutsEnabled
                        ? t("settings.payoutsEnabled", "Payouts Enabled")
                        : t("settings.payoutsNotEnabled", "Payouts Not Yet Enabled")}
                    </span>
                  </div>
                </div>

                {/* Balance Display */}
                {connectStatus.chargesEnabled && connectStatus.balance && (
                  <div className="grid grid-cols-2 gap-4 p-4 rounded-lg border bg-muted/30">
                    <div>
                      <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-1">
                        <Wallet className="h-4 w-4" />
                        {t("settings.availableBalance", "Available")}
                      </div>
                      <div className="text-xl font-semibold">
                        {connectStatus.balance.available.map((b, i) => (
                          <span key={i}>€{b.amount.toFixed(2)}</span>
                        ))}
                        {connectStatus.balance.available.length === 0 && <span>€0.00</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-muted-foreground mb-1">
                        {t("settings.pendingBalance", "Pending")}
                      </div>
                      <div className="text-xl font-semibold text-muted-foreground">
                        {connectStatus.balance.pending.map((b, i) => (
                          <span key={i}>€{b.amount.toFixed(2)}</span>
                        ))}
                        {connectStatus.balance.pending.length === 0 && <span>€0.00</span>}
                      </div>
                    </div>
                  </div>
                )}

                {/* Warning if setup incomplete */}
                {(!connectStatus.chargesEnabled || !connectStatus.payoutsEnabled) && (
                  <Alert variant="destructive" className="border-amber-500 bg-amber-500/10">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>{t("settings.setupIncomplete", "Setup Incomplete")}</AlertTitle>
                    <AlertDescription>
                      {t("settings.setupIncompleteDescription", "Please complete your payment account setup to start receiving payments.")}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex gap-2">
                  {(!connectStatus.chargesEnabled || !connectStatus.payoutsEnabled) && (
                    <Button onClick={handleConnectMollie} disabled={connectLoading}>
                      {connectLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {t("settings.completeSetup", "Complete Setup")}
                    </Button>
                  )}
                  <Button variant="outline" onClick={handleRefreshStatus} disabled={checkingStatus}>
                    {checkingStatus && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {t("settings.refreshStatus", "Refresh Status")}
                  </Button>
                  {connectStatus.chargesEnabled && (
                    <Button 
                      variant="outline" 
                      onClick={() => window.open("https://my.mollie.com/dashboard", "_blank")}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      {t("settings.mollieDashboard", "Payment Dashboard")}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <Alert>
                  <CreditCard className="h-4 w-4" />
                  <AlertTitle>{t("settings.notConnected", "Not Connected")}</AlertTitle>
                  <AlertDescription>
                    {t("settings.notConnectedDescription", "Connect your payment account to receive payments when players book lessons with your trainers.")}
                  </AlertDescription>
                </Alert>
                
                <Button onClick={handleConnectMollie} disabled={connectLoading}>
                  {connectLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  <CreditCard className="h-4 w-4 mr-2" />
                  {t("settings.connectMollie", "Connect Payment Account")}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* General Terms */}
        <Card>
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
        <Card>
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

        {/* Managers */}
        <Card>
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
                        size="icon"
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
        <Card>
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
                  <SelectItem value="es">🇪🇸 Español</SelectItem>
                  <SelectItem value="de">🇩🇪 Deutsch</SelectItem>
                  <SelectItem value="fr">🇫🇷 Français</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
        </Card>

        {/* Danger Zone */}
        <div className="pt-6 border-t border-destructive/20">
          <h3 className="text-lg font-semibold text-destructive mb-4">{t('settings.dangerZone', 'Danger Zone')}</h3>
          <DeleteAccountDialog />
        </div>
      </div>
    </div>
  );
}
