import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { 
  ArrowLeft, 
  Euro,
  CreditCard,
  CheckCircle2,
  ExternalLink,
  Wallet,
  AlertCircle,
  Loader2,
  Info,
  RefreshCw
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { connectAcademyMollie, checkAcademyConnectStatus, type AcademyConnectStatus } from '@/lib/academyPayments';
import { logger } from '@/lib/logger';

export default function AcademyEarnings() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { t } = useTranslation('academy');
  const { activeAcademy } = useAcademyContext();
  
  const [connectStatus, setConnectStatus] = useState<AcademyConnectStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [connectLoading, setConnectLoading] = useState(false);

  useEffect(() => {
    if (activeAcademy?.id) {
      checkStatus();
    }
  }, [activeAcademy?.id]);

  // Handle return from Mollie Connect onboarding
  useEffect(() => {
    if (searchParams.get('connected') === 'true') {
      toast({ 
        title: t('settings.mollieConnectSuccess'), 
        description: t('settings.mollieConnectSuccessDescription') 
      });
      checkStatus();
    }
    if (searchParams.get('refresh') === 'true') {
      toast({ 
        title: t('settings.mollieConnectRefresh'), 
        description: t('settings.mollieConnectRefreshDescription') 
      });
      checkStatus();
    }
  }, [searchParams]);

  const checkStatus = async () => {
    if (!activeAcademy?.id) return;
    
    setStatusLoading(true);
    try {
      const status = await checkAcademyConnectStatus(activeAcademy.id);
      setConnectStatus(status);
    } catch (err) {
      logger.warn('Error checking academy connect status', { error: err, component: 'AcademyEarnings' });
      setConnectStatus({ 
        connected: false, 
        chargesEnabled: false, 
        payoutsEnabled: false, 
        onboardingComplete: false 
      });
    } finally {
      setStatusLoading(false);
    }
  };

  const handleConnectMollie = async () => {
    if (!activeAcademy?.id) return;
    
    setConnectLoading(true);
    try {
      const url = await connectAcademyMollie(activeAcademy.id);
      if (url) {
        window.location.href = url;
      } else {
        // Already connected
        toast({
          title: t('settings.mollieConnectSuccess'),
          description: t('settings.mollieConnectSuccessDescription'),
        });
        checkStatus();
      }
    } catch (err: any) {
      toast({
        title: t('common.error'),
        description: err.message || 'Failed to connect payment account',
        variant: 'destructive',
      });
    } finally {
      setConnectLoading(false);
    }
  };

  const handleRefreshStatus = async () => {
    await checkStatus();
    toast({ 
      title: t('settings.statusRefreshed'), 
      description: t('settings.statusRefreshedDescription') 
    });
  };

  if (statusLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>{t('settings.checkingStatus')}</span>
        </div>
      </div>
    );
  }

  const isConnected = connectStatus?.connected && connectStatus?.chargesEnabled;
  const needsOnboarding = connectStatus?.connected && !connectStatus?.onboardingComplete;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('earnings.title')}</h1>
          <p className="text-muted-foreground">{t('earnings.description')}</p>
        </div>
        {isConnected && (
          <Button variant="outline" size="sm" onClick={handleRefreshStatus}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('settings.refreshStatus')}
          </Button>
        )}
      </div>

      {/* Info Card - How academy payments work */}
      <Card className="border-blue-200 bg-gradient-to-r from-blue-50 to-sky-50 dark:from-blue-950/20 dark:to-sky-950/20">
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900">
              <Info className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="font-medium text-blue-800 dark:text-blue-200">
                {t('earnings.howItWorks')}
              </p>
              <p className="text-sm text-blue-600 dark:text-blue-300 mt-1">
                {t('earnings.howItWorksDescription')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Not Connected Card */}
      {!connectStatus?.connected && (
        <Card className="border-primary/50 bg-gradient-to-r from-primary/5 to-primary/10">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-primary/10">
                <CreditCard className="h-6 w-6 text-primary" />
              </div>
              <div>
                <CardTitle>{t('settings.mollieConnect')}</CardTitle>
                <CardDescription>{t('settings.notConnectedDescription')}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span>{t('earnings.benefit1')}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span>{t('earnings.benefit2')}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span>{t('earnings.benefit3')}</span>
              </div>
              <Button 
                onClick={handleConnectMollie} 
                disabled={connectLoading}
                className="w-full mt-4"
              >
                {connectLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {t('common.saving')}
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4 mr-2" />
                    {t('settings.connectMollie')}
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Onboarding Incomplete Card */}
      {needsOnboarding && (
        <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <AlertCircle className="h-6 w-6 text-orange-500 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="font-medium text-orange-800 dark:text-orange-200">
                  {t('settings.setupIncomplete')}
                </h3>
                <p className="text-sm text-orange-600 dark:text-orange-300 mt-1">
                  {t('settings.setupIncompleteDescription')}
                </p>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="mt-4"
                  onClick={handleConnectMollie}
                  disabled={connectLoading}
                >
                  {connectLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  {t('settings.completeSetup')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connected - Status & Balance */}
      {isConnected && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Connection Status */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5" />
                {t('earnings.connectionStatus')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('settings.paymentsEnabled')}</span>
                <Badge variant={connectStatus.chargesEnabled ? 'default' : 'secondary'}>
                  {connectStatus.chargesEnabled ? (
                    <><CheckCircle2 className="h-3 w-3 mr-1" /> {t('subscription.active')}</>
                  ) : (
                    t('settings.paymentsNotEnabled')
                  )}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('settings.payoutsEnabled')}</span>
                <Badge variant={connectStatus.payoutsEnabled ? 'default' : 'secondary'}>
                  {connectStatus.payoutsEnabled ? (
                    <><CheckCircle2 className="h-3 w-3 mr-1" /> {t('subscription.active')}</>
                  ) : (
                    t('settings.payoutsNotEnabled')
                  )}
                </Badge>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full mt-2"
                onClick={() => window.open('https://my.mollie.com/dashboard', '_blank')}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                {t('settings.mollieDashboard')}
              </Button>
            </CardContent>
          </Card>

          {/* Balance */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Euro className="h-5 w-5" />
                {t('earnings.balance')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {connectStatus.balance ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('settings.availableBalance')}</span>
                    <span className="text-lg font-semibold text-green-600">
                      €{connectStatus.balance.available?.[0]?.amount?.toFixed(2) || '0.00'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{t('settings.pendingBalance')}</span>
                    <span className="text-lg font-medium text-muted-foreground">
                      €{connectStatus.balance.pending?.[0]?.amount?.toFixed(2) || '0.00'}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('earnings.noBalanceData')}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Trainer Payment Info */}
      <Card>
        <CardHeader>
          <CardTitle>{t('earnings.trainerPayments')}</CardTitle>
          <CardDescription>{t('earnings.trainerPaymentsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>{t('earnings.trainerPaymentsInfo1')}</p>
            <p>{t('earnings.trainerPaymentsInfo2')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
