import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FullPageLoader } from '@/components/ui/page-spinner';
import { MailX, CheckCircle2, AlertCircle } from 'lucide-react';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

/**
 * `/manage-email` — the PUBLIC manage page an email footer's unsubscribe link opens.
 *
 * PUBLIC AND OUTSIDE /app ON PURPOSE: a marketing recipient may have no account, so nothing here
 * may sit behind auth, a role layout, or any guard. The SIGNED TOKEN in `?token=` is the entire
 * authority — the page trades it for a redacted context ("stop marketing from {scope} to
 * {redacted address}?") and one MONOTONIC action. Forwarding the link can at worst replay an
 * unsubscribe, never undo one.
 *
 * THE TOKEN IS SCRUBBED FROM THE ADDRESS BAR immediately after being read. Pageview analytics
 * already allow-list query params away, but the URL also leaks through browser history sync,
 * referrer headers and screenshots — none of which an analytics filter touches.
 *
 * FAIL DIRECTIONS mirror the endpoint contract: statuses are CONTENT (a dead link renders
 * friendly copy), while an OPERATIONAL failure (503) renders a retry — it must never be
 * presented as "this link is broken", which would send the person away while their opt-out was
 * simply deferred.
 */

type PageState =
  | { phase: 'loading' }
  | { phase: 'live'; scopeName: string; destinationRedacted: string }
  | { phase: 'applying'; scopeName: string; destinationRedacted: string }
  | { phase: 'done'; already: boolean }
  | { phase: 'dead'; status: string }
  | { phase: 'operational' };

const MANAGE_ENDPOINT = `${SUPABASE_URL}/functions/v1/notif-manage`;

export default function ManageEmail() {
  const { t } = useTranslation('common');
  const [state, setState] = useState<PageState>({ phase: 'loading' });
  // Read once, then scrub. A ref rather than state: the token must never sit in anything React
  // devtools or state-persistence middleware could serialize.
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (tokenRef.current !== null) return;
    const url = new URL(window.location.href);
    tokenRef.current = url.searchParams.get('token') ?? '';
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, []);

  const loadContext = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch(MANAGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'context', token: tokenRef.current }),
      });
      if (res.status >= 500) {
        // EVERY 5xx is operational — the endpoint's own bug included. Nothing was recorded, so
        // "link broken" would be a lie that sends the person away while retry could still work.
        setState({ phase: 'operational' });
        return;
      }
      const body = await res.json();
      if (res.ok && body.status === 'live') {
        setState({
          phase: 'live',
          scopeName: body.scopeName ?? 'PadelTrainer.ai',
          destinationRedacted: body.destinationRedacted ?? '',
        });
      } else {
        setState({ phase: 'dead', status: String(body.status ?? 'invalid') });
      }
    } catch {
      setState({ phase: 'operational' });
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const apply = async () => {
    if (state.phase !== 'live') return;
    setState({ ...state, phase: 'applying' });
    try {
      const res = await fetch(MANAGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'apply', token: tokenRef.current }),
      });
      if (res.status >= 500) {
        // The opt-out is deferred, not lost — bring the button back so they can retry.
        setState({ phase: 'operational' });
        return;
      }
      const body = await res.json();
      if (res.ok && (body.result === 'applied' || body.result === 'already_applied')) {
        setState({ phase: 'done', already: body.result === 'already_applied' });
      } else {
        setState({ phase: 'dead', status: String(body.result ?? 'invalid') });
      }
    } catch {
      setState({ phase: 'operational' });
    }
  };

  if (state.phase === 'loading') return <FullPageLoader />;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50/80 p-4">
      <Card className="w-full max-w-md" data-testid={`manage-email-${state.phase}`}>
        {state.phase === 'live' || state.phase === 'applying' ? (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MailX className="h-5 w-5" />
                {t('manageEmail.title', 'Unsubscribe from marketing email')}
              </CardTitle>
              <CardDescription>
                {t('manageEmail.confirmBody', {
                  defaultValue:
                    'Stop marketing email from {{scope}} to {{address}}? Service messages about your bookings are not affected.',
                  scope: state.scopeName,
                  address: state.destinationRedacted,
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={apply} disabled={state.phase === 'applying'} className="w-full">
                {state.phase === 'applying'
                  ? t('manageEmail.applying', 'Unsubscribing…')
                  : t('manageEmail.confirm', 'Unsubscribe')}
              </Button>
            </CardContent>
          </>
        ) : state.phase === 'done' ? (
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              {t('manageEmail.doneTitle', "You're unsubscribed")}
            </CardTitle>
            <CardDescription>
              {state.already
                ? t('manageEmail.alreadyBody', 'This address was already unsubscribed. No further marketing email will be sent.')
                : t('manageEmail.doneBody', 'No further marketing email will be sent to this address.')}
            </CardDescription>
          </CardHeader>
        ) : state.phase === 'dead' ? (
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-5 w-5" />
              {t('manageEmail.deadTitle', 'This link is no longer active')}
            </CardTitle>
            <CardDescription>
              {t(
                'manageEmail.deadBody',
                'Unsubscribe links expire after a while. Use the link in a more recent email, or contact support@padeltrainer.ai and we will take care of it.',
              )}
            </CardDescription>
          </CardHeader>
        ) : (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertCircle className="h-5 w-5" />
                {t('manageEmail.errorTitle', 'Something went wrong')}
              </CardTitle>
              <CardDescription>
                {t(
                  'manageEmail.errorBody',
                  'We could not process this right now. Your request has not been lost — please try again.',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void loadContext()} className="w-full">
                {t('manageEmail.retry', 'Try again')}
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </main>
  );
}
