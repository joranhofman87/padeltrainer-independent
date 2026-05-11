import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Calendar, Check, Loader2, AlertCircle, Unlink } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  getCalendarConnection,
  initiateGoogleCalendarAuth,
  disconnectGoogleCalendar,
  toggleCalendarSync,
  CalendarConnection,
} from '@/lib/calendar';
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

export default function CalendarSettings() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation('common');

  const [connection, setConnection] = useState<CalendarConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/app/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    const success = searchParams.get('success');
    const error = searchParams.get('error');

    if (success === 'true') {
      toast({
        title: t('calendarSettings.connected'),
        description: t('calendarSettings.connectedDescription'),
      });
      // Clear URL params
      navigate('/settings/calendar', { replace: true });
    } else if (error) {
      toast({
        title: t('calendarSettings.connectionFailed'),
        description: getErrorMessage(error),
        variant: 'destructive',
      });
      navigate('/settings/calendar', { replace: true });
    }
  }, [searchParams, toast, navigate]);

  useEffect(() => {
    if (user) {
      fetchConnection();
    }
  }, [user]);

  const fetchConnection = async () => {
    setLoading(true);
    const data = await getCalendarConnection();
    setConnection(data);
    setLoading(false);
  };

  const getErrorMessage = (error: string): string => {
    switch (error) {
      case 'not_configured':
        return 'Google Calendar integration is not yet configured. Please add your Google credentials.';
      case 'access_denied':
        return 'You denied access to Google Calendar.';
      case 'database_error':
        return 'Failed to save calendar connection. Please try again.';
      default:
        return `Connection error: ${error}`;
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    const authUrl = await initiateGoogleCalendarAuth(window.location.href);
    
    if (authUrl) {
      window.location.href = authUrl;
    } else {
      toast({
        title: t('calendarSettings.connectionFailed'),
        description: t('calendarSettings.notConfigured'),
        variant: 'destructive',
      });
      setConnecting(false);
    }
  };

  const handleToggleSync = async (enabled: boolean) => {
    setToggling(true);
    const success = await toggleCalendarSync(enabled);
    
    if (success) {
      setConnection(prev => prev ? { ...prev, is_active: enabled } : null);
      toast({
        title: enabled ? t('calendarSettings.syncEnabled') : t('calendarSettings.syncPaused'),
        description: enabled
          ? t('calendarSettings.syncEnabledDescription')
          : t('calendarSettings.syncPausedDescription'),
      });
    } else {
      toast({
        title: t('calendarSettings.failedToUpdate'),
        description: t('calendarSettings.failedToUpdateDescription'),
        variant: 'destructive',
      });
    }
    setToggling(false);
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    const success = await disconnectGoogleCalendar();
    
    if (success) {
      setConnection(null);
      toast({
        title: t('calendarSettings.disconnected'),
        description: t('calendarSettings.disconnectedDescription'),
      });
    } else {
      toast({
        title: t('calendarSettings.failedToDisconnect'),
        description: t('calendarSettings.failedToDisconnectDescription'),
        variant: 'destructive',
      });
    }
    setDisconnecting(false);
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-2xl py-8 px-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">{t('calendarSettings.title')}</h1>
            <p className="text-muted-foreground">{t('calendarSettings.subtitle')}</p>
          </div>
        </div>

        {/* Connection Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Google Calendar
            </CardTitle>
            <CardDescription>
              {t('calendarSettings.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {connection ? (
              <>
                {/* Connected State */}
                <div className="flex items-center gap-3 p-4 bg-green-50 dark:bg-green-950/30 rounded-lg border border-green-200 dark:border-green-800">
                  <div className="h-10 w-10 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                    <Check className="h-5 w-5 text-green-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-green-700 dark:text-green-300">{t('calendarSettings.connectedState')}</p>
                    <p className="text-sm text-green-600 dark:text-green-400">
                      {connection.calendar_id || 'Primary calendar'}
                    </p>
                  </div>
                </div>

                {/* Sync Toggle */}
                <div className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-0.5">
                     <Label htmlFor="sync-toggle" className="font-medium">
                       {t('calendarSettings.autoSync')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('calendarSettings.autoSyncDescription')}
                    </p>
                  </div>
                  <Switch
                    id="sync-toggle"
                    checked={connection.is_active}
                    onCheckedChange={handleToggleSync}
                    disabled={toggling}
                  />
                </div>

                {/* Info Box */}
                <div className="flex gap-3 p-4 bg-muted rounded-lg">
                  <AlertCircle className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="text-sm text-muted-foreground">
                    <p className="font-medium mb-1">{t('calendarSettings.howItWorks')}</p>
                    <ul className="list-disc list-inside space-y-1">
                       <li>{t('calendarSettings.howBookingAdded')}</li>
                       <li>{t('calendarSettings.howDetailsIncluded')}</li>
                       <li>{t('calendarSettings.howCancelRemoved')}</li>
                    </ul>
                  </div>
                </div>

                {/* Disconnect Button */}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full text-destructive hover:text-destructive"
                      disabled={disconnecting}
                    >
                      {disconnecting ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Unlink className="h-4 w-4 mr-2" />
                      )}
                      {t('calendarSettings.disconnect')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                       <AlertDialogTitle>{t('calendarSettings.disconnectConfirmTitle')}</AlertDialogTitle>
                       <AlertDialogDescription>
                         {t('calendarSettings.disconnectConfirmDescription')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                       <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                       <AlertDialogAction onClick={handleDisconnect}>
                         {t('calendarSettings.disconnect')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            ) : (
              <>
                {/* Not Connected State */}
                <div className="text-center py-8">
                  <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                    <Calendar className="h-8 w-8 text-muted-foreground" />
                  </div>
                   <h3 className="font-medium mb-2">{t('calendarSettings.notConnected')}</h3>
                   <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                     {t('calendarSettings.notConnectedDescription')}
                  </p>
                  <Button onClick={handleConnect} disabled={connecting} size="lg">
                    {connecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Calendar className="h-4 w-4 mr-2" />
                    )}
                    {t('calendarSettings.connectButton')}
                  </Button>
                </div>

                {/* Benefits */}
                <div className="border-t pt-6">
                  <p className="text-sm font-medium mb-3">{t('calendarSettings.benefits')}</p>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-600" />
                      {t('calendarSettings.benefitReminders')}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-600" />
                      {t('calendarSettings.benefitSeeAlongside')}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-green-600" />
                      {t('calendarSettings.benefitAnyDevice')}
                    </li>
                  </ul>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
