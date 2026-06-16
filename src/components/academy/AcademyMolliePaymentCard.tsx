import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CreditCard,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Wallet,
  Loader2,
  Unplug,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import type { AcademyConnectStatus } from '@/lib/academyPayments';
import {
  getAcademyMollieUiState,
  getAcademyPaymentUnavailableReasonKey,
} from '@/lib/academyMollieSettingsState';
import { formatCurrency } from '@/lib/format';

export interface AcademyMolliePaymentCardProps {
  connectStatus: AcademyConnectStatus | null;
  checkingStatus: boolean;
  connectLoading: boolean;
  /** When true, user session is missing — do not call Mollie edge functions. */
  sessionMissing?: boolean;
  onConnect: () => void;
  onRefresh: () => void;
  onDisconnect: () => Promise<void>;
}

export function AcademyMolliePaymentCard({
  connectStatus,
  checkingStatus,
  connectLoading,
  sessionMissing = false,
  onConnect,
  onRefresh,
  onDisconnect,
}: AcademyMolliePaymentCardProps) {
  const { t } = useTranslation('academy');
  const [disconnecting, setDisconnecting] = useState(false);

  const uiState = getAcademyMollieUiState(connectStatus);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <Card className={flushOnMobileCardClass()}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">{t('settings.mollieConnect', 'Payment Setup')}</CardTitle>
        </div>
        <CardDescription>
          {t(
            'settings.mollieConnectDescription',
            'Connect your payment account to receive payments from lesson bookings.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sessionMissing ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{t('settings.sessionRequiredTitle', 'Sign in required')}</AlertTitle>
            <AlertDescription>
              {t(
                'settings.sessionRequiredDescription',
                'Please log in again to manage payment settings.',
              )}
            </AlertDescription>
          </Alert>
        ) : checkingStatus ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('settings.checkingStatus', 'Checking status...')}
          </div>
        ) : uiState === 'not_connected' ? (
          <>
            <Alert>
              <CreditCard className="h-4 w-4" />
              <AlertTitle>{t('settings.notConnected', 'Not Connected')}</AlertTitle>
              <AlertDescription>
                {t(
                  'settings.notConnectedDescription',
                  'Connect your payment account to receive payments when players book lessons with your trainers.',
                )}
              </AlertDescription>
            </Alert>
            <Button onClick={onConnect} disabled={connectLoading || sessionMissing}>
              {connectLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <CreditCard className="h-4 w-4 mr-2" />
              {t('settings.connectMollie', 'Connect Payment Account')}
            </Button>
          </>
        ) : uiState === 'connected_not_ready' ? (
          <>
            <Alert variant="destructive" className="border-amber-500 bg-amber-500/10">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>
                {t('settings.paymentNotReadyTitle', 'Online payments not ready')}
              </AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  {t(
                    'settings.paymentNotReadyDescription',
                    'Mollie is connected, but online payments are not ready.',
                  )}
                </p>
                <p className="font-medium">
                  {t(getAcademyPaymentUnavailableReasonKey(connectStatus?.paymentUnavailableReason))}
                </p>
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onConnect} disabled={connectLoading || sessionMissing}>
                {connectLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('settings.reconnectMollie', 'Reconnect Mollie')}
              </Button>
              <Button variant="outline" onClick={onRefresh} disabled={checkingStatus || sessionMissing}>
                {checkingStatus && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('settings.refreshStatus', 'Refresh Status')}
              </Button>
              <DisconnectButton
                disconnecting={disconnecting}
                disabled={sessionMissing}
                onConfirm={handleDisconnect}
                label={t('settings.disconnectMollie', 'Disconnect')}
                title={t('settings.disconnectMollieTitle', 'Disconnect Mollie?')}
                description={t(
                  'settings.disconnectMollieDescription',
                  'This removes your Mollie connection. Public invoice online payment will be unavailable until you reconnect. Past invoices and payments are not changed.',
                )}
                cancelLabel={t('common.cancel', 'Cancel')}
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              <span className="font-medium">
                {t('settings.paymentReady', 'Ready for online payments')}
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {connectStatus?.chargesEnabled ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-amber-500" />
                )}
                <span className="font-medium">
                  {connectStatus?.chargesEnabled
                    ? t('settings.paymentsEnabled', 'Payments Enabled')
                    : t('settings.paymentsNotEnabled', 'Payments Not Yet Enabled')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {connectStatus?.payoutsEnabled ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-amber-500" />
                )}
                <span className="font-medium">
                  {connectStatus?.payoutsEnabled
                    ? t('settings.payoutsEnabled', 'Payouts Enabled')
                    : t('settings.payoutsNotEnabled', 'Payouts Not Yet Enabled')}
                </span>
              </div>
            </div>

            {connectStatus?.chargesEnabled && connectStatus.balance && (
              <div className="grid grid-cols-2 gap-4 p-4 rounded-lg border bg-muted/30">
                <div>
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-1">
                    <Wallet className="h-4 w-4" />
                    {t('settings.availableBalance', 'Available')}
                  </div>
                  <div className="text-xl font-semibold">
                    {connectStatus.balance.available.map((b, i) => (
                      <span key={i}>{formatCurrency(b.amount)}</span>
                    ))}
                    {connectStatus.balance.available.length === 0 && <span>{formatCurrency(0)}</span>}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground mb-1">
                    {t('settings.pendingBalance', 'Pending')}
                  </div>
                  <div className="text-xl font-semibold text-muted-foreground">
                    {connectStatus.balance.pending.map((b, i) => (
                      <span key={i}>{formatCurrency(b.amount)}</span>
                    ))}
                    {connectStatus.balance.pending.length === 0 && <span>{formatCurrency(0)}</span>}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onRefresh} disabled={checkingStatus || sessionMissing}>
                {checkingStatus && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('settings.refreshStatus', 'Refresh Status')}
              </Button>
              <Button
                variant="outline"
                disabled={sessionMissing}
                onClick={() => window.open('https://my.mollie.com/dashboard', '_blank')}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                {t('settings.mollieDashboard', 'Payment Dashboard')}
              </Button>
              <DisconnectButton
                disconnecting={disconnecting}
                disabled={sessionMissing}
                onConfirm={handleDisconnect}
                label={t('settings.disconnectMollie', 'Disconnect')}
                title={t('settings.disconnectMollieTitle', 'Disconnect Mollie?')}
                description={t(
                  'settings.disconnectMollieDescription',
                  'This removes your Mollie connection. Public invoice online payment will be unavailable until you reconnect. Past invoices and payments are not changed.',
                )}
                cancelLabel={t('common.cancel', 'Cancel')}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DisconnectButton({
  disconnecting,
  disabled,
  onConfirm,
  label,
  title,
  description,
  cancelLabel,
}: {
  disconnecting: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  label: string;
  title: string;
  description: string;
  cancelLabel: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          disabled={disabled}
        >
          <Unplug className="h-4 w-4 mr-2" />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={disconnecting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {disconnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
