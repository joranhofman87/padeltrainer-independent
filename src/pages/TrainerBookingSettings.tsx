import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ArrowLeft, ShieldCheck, Zap, Loader2 } from 'lucide-react';
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
  const [saving, setSaving] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);

  useEffect(() => {
    if (!loading && user && role === 'trainer') {
      fetchSettings();
    }
  }, [user, role, loading]);
  // Auth is now handled by TrainerLayout

  const fetchSettings = async () => {
    const { data } = await supabase
      .from('trainer_profiles')
      .select('require_booking_approval, use_manual_invoicing')
      .eq('user_id', user!.id)
      .single();

    if (data) {
      setRequireApproval(data.require_booking_approval || false);
      setUseManualInvoicing(data.use_manual_invoicing || false);
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
      <main className="container mx-auto px-4 py-8 max-w-2xl">
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
      </main>
    </>
  );
}
