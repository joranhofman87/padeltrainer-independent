import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from 'react-i18next';
import { 
  Settings, 
  CreditCard, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink, 
  Wallet,
  Loader2
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyManagers } from '@/lib/academy';
import { 
  connectAcademyMollie, 
  checkAcademyConnectStatus,
  type AcademyConnectStatus 
} from '@/lib/academyPayments';
import { DeleteAccountDialog } from '@/components/settings/DeleteAccountDialog';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

export default function AcademySettings() {
  const { t } = useTranslation('academy');
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { activeAcademy } = useAcademyContext();
  const [managers, setManagers] = useState<any[]>([]);
  
  // Mollie Connect state
  const [connectStatus, setConnectStatus] = useState<AcademyConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);

  useEffect(() => {
    async function fetchData() {
      if (!activeAcademy) return;
      
      const data = await getAcademyManagers(activeAcademy.id);
      setManagers(data);
      
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

  // Handle Mollie redirect callbacks
  useEffect(() => {
    if (searchParams.get("mollie_success") === "true" && activeAcademy) {
      toast({
        title: t("settings.mollieConnectSuccess", "Payment Account Connected"),
        description: t("settings.mollieConnectSuccessDescription", "Your payment account has been connected successfully."),
      });
      // Refresh status
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
                  <Badge variant={manager.role === 'owner' ? 'default' : 'secondary'}>
                    {manager.role === 'owner' ? t('managers.owner') : t('managers.manager')}
                  </Badge>
                </div>
              ))}
              
              {managers.length === 0 && (
                <p className="text-center text-muted-foreground py-4">
                  {t('managers.noManagers', 'No managers found')}
                </p>
              )}
            </div>
          </CardContent>
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
