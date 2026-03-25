import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, ShieldCheck, Zap, Loader2, MessageSquare, Euro } from 'lucide-react';
import { ExtraCostPresetsCard } from '@/components/settings/ExtraCostPresetsCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useToast } from '@/hooks/use-toast';

export default function TrainerBookingSettings() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');
  const { toast } = useToast();

  const [requireApproval, setRequireApproval] = useState(false);
  const [useManualInvoicing, setUseManualInvoicing] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingWelcome, setSavingWelcome] = useState(false);
  const [savingVat, setSavingVat] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);

  useEffect(() => {
    if (!loading && user && role === 'trainer') {
      fetchSettings();
    }
  }, [user, role, loading]);

  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);
  const [showVatBulkDialog, setShowVatBulkDialog] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [pendingVatValue, setPendingVatValue] = useState<boolean | null>(null);

  const fetchSettings = async () => {
    const { data } = await supabase
      .from('trainer_profiles')
      .select('id, require_booking_approval, use_manual_invoicing, welcome_message, prices_include_vat')
      .eq('user_id', user!.id)
      .single();

    if (data) {
      setTrainerProfileId(data.id);
      setRequireApproval(data.require_booking_approval || false);
      setUseManualInvoicing(data.use_manual_invoicing || false);
      setWelcomeMessage(data.welcome_message || '');
      setPricesIncludeVat(data.prices_include_vat !== false);
    }
    setLoadingSettings(false);
  };

  const handleToggleApproval = async (value: boolean) => {
    setSaving(true);
    const { error } = await supabase
      .from('trainer_profiles')
      .update({ require_booking_approval: value })
      .eq('user_id', user!.id);

    if (error) {
      toast({
        title: t('common:error'),
        description: 'Failed to update setting',
        variant: 'destructive',
      });
    } else {
      setRequireApproval(value);
      toast({
        title: t('common:success'),
        description: value 
          ? t('bookingSettings.approvalEnabled')
          : t('bookingSettings.approvalDisabled'),
      });
    }
    setSaving(false);
  };

  const handleSaveWelcomeMessage = async () => {
    setSavingWelcome(true);
    const { error } = await supabase
      .from('trainer_profiles')
      .update({ welcome_message: welcomeMessage.trim() || null } as any)
      .eq('user_id', user!.id);

    if (error) {
      toast({ title: t('common:error'), description: error.message, variant: 'destructive' });
    } else {
      toast({ title: t('welcomeMessage.saved') });
    }
    setSavingWelcome(false);
  };

  const handleToggleVat = async (value: boolean) => {
    setSavingVat(true);
    const { error } = await supabase
      .from('trainer_profiles')
      .update({ prices_include_vat: value } as any)
      .eq('user_id', user!.id);

    if (error) {
      toast({ title: t('common:error'), description: error.message, variant: 'destructive' });
    } else {
      setPricesIncludeVat(value);
      toast({ title: t('common:success'), description: t('bookingSettings.vatSaved') });
      // Ask if they want to bulk update existing slots/invoices
      setPendingVatValue(value);
      setShowVatBulkDialog(true);
    }
    setSavingVat(false);
  };

  const handleBulkUpdateVat = async () => {
    if (!trainerProfileId || pendingVatValue === null) return;
    setBulkUpdating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bulk-update-vat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            trainerId: trainerProfileId,
            pricesIncludeVat: pendingVatValue,
          }),
        }
      );
      const result = await res.json();
      if (!res.ok) throw new Error(result.error);
      toast({
        title: t('common:success'),
        description: t('bookingSettings.vatBulkUpdateSuccess', {
          slots: result.slotsUpdated,
          invoices: result.invoicesUpdated,
        }),
      });
    } catch (err: any) {
      toast({
        title: t('common:error'),
        description: t('bookingSettings.vatBulkUpdateError'),
        variant: 'destructive',
      });
    }
    setBulkUpdating(false);
    setShowVatBulkDialog(false);
    setPendingVatValue(null);
  };

  if (loading || loadingSettings) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <>
      {/* Sub-page Header */}
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app/trainer/settings')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('bookingSettings.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('bookingSettings.subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8 max-w-2xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              {t('bookingSettings.approvalTitle')}
            </CardTitle>
            <CardDescription>
              {t('bookingSettings.approvalSubtitle')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Approval Toggle */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex-1 pr-4">
                <Label htmlFor="require-approval" className="font-medium">
                  {t('bookingSettings.requireApproval')}
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  {useManualInvoicing
                    ? t('bookingSettings.requireApprovalDescriptionInvoice')
                    : t('bookingSettings.requireApprovalDescriptionOnline')
                  }
                </p>
              </div>
              <Switch
                id="require-approval"
                checked={requireApproval}
                onCheckedChange={handleToggleApproval}
                disabled={saving}
              />
            </div>

            {/* Explanation Cards */}
            <div className="grid gap-4 md:grid-cols-2">
              <div className={`p-4 rounded-lg border-2 transition-colors ${
                !requireApproval 
                  ? 'border-primary bg-primary/5' 
                  : 'border-muted bg-muted/50'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="h-5 w-5 text-green-600" />
                  <span className="font-medium">{t('bookingSettings.autoAccept')}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {useManualInvoicing
                    ? t('bookingSettings.autoAcceptDescriptionInvoice')
                    : t('bookingSettings.autoAcceptDescriptionOnline')
                  }
                </p>
              </div>

              <div className={`p-4 rounded-lg border-2 transition-colors ${
                requireApproval 
                  ? 'border-primary bg-primary/5' 
                  : 'border-muted bg-muted/50'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  <ShieldCheck className="h-5 w-5 text-blue-600" />
                  <span className="font-medium">{t('bookingSettings.manualApproval')}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {useManualInvoicing
                    ? t('bookingSettings.manualApprovalDescriptionInvoice')
                    : t('bookingSettings.manualApprovalDescriptionOnline')
                  }
                </p>
              </div>
            </div>

            {saving && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:saving')}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Welcome Message Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-primary" />
              {t('welcomeMessage.title')}
            </CardTitle>
            <CardDescription>
              {t('welcomeMessage.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={welcomeMessage}
              onChange={(e) => setWelcomeMessage(e.target.value)}
              placeholder={t('welcomeMessage.placeholder')}
              rows={4}
              maxLength={1000}
            />
            <div className="flex justify-end">
              <Button onClick={handleSaveWelcomeMessage} disabled={savingWelcome}>
                {savingWelcome && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('common:save', 'Save')}
              </Button>
            </div>
          </CardContent>
        </Card>
        {/* Extra Cost Presets Card */}
        {trainerProfileId && (
          <ExtraCostPresetsCard trainerId={trainerProfileId} />
        )}

        {/* VAT Settings Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Euro className="h-5 w-5 text-primary" />
              {t('bookingSettings.vatTitle')}
            </CardTitle>
            <CardDescription>
              {t('bookingSettings.vatDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex-1 pr-4">
                <Label htmlFor="vat-toggle" className="font-medium">
                  {t('bookingSettings.vatInclLabel')}
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('bookingSettings.vatInclDescription')}
                </p>
              </div>
              <Switch
                id="vat-toggle"
                checked={pricesIncludeVat}
                onCheckedChange={handleToggleVat}
                disabled={savingVat}
              />
            </div>
            <Alert>
              <AlertDescription className="text-sm text-muted-foreground">
                ⚠️ {t('bookingSettings.vatWarning')}
              </AlertDescription>
            </Alert>
            {savingVat && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('common:saving')}
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <AlertDialog open={showVatBulkDialog} onOpenChange={setShowVatBulkDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bookingSettings.vatBulkUpdateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('bookingSettings.vatBulkUpdateDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setShowVatBulkDialog(false);
                setPendingVatValue(null);
              }}
              disabled={bulkUpdating}
            >
              {t('bookingSettings.vatBulkUpdateCancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkUpdateVat} disabled={bulkUpdating}>
              {bulkUpdating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('bookingSettings.vatBulkUpdateConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
