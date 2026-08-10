import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

/**
 * U2 — the identity-verification link target (the email link lands here).
 *
 * The page holds ONLY the opaque token from the query string. It calls verify-identity to disclose
 * the minimal candidate list (only reachable because the token proves control of the address), then
 * records the explicit choice — an existing Player, or "someone new". It never learns anything about
 * a candidate until the token verifies, and it renders one GENERIC message for every failure
 * (invalid / expired / stale) so nothing here is an enumeration oracle.
 *
 * Cross-device resume of the ORIGINAL booking (the person may click the link on their phone while
 * the booking sits in a desktop tab) is a delivery-time UX concern for the owner's activation gate;
 * this slice confirms the selection and tells them to return to their booking to finish. Email
 * delivery itself is inert here (owner-gated), so this page is exercised by tests, not live mail.
 */
type Candidate = { person_id: string; name: string };
type Phase = 'loading' | 'choose' | 'done' | 'generic_error' | 'unavailable';

export default function VerifyIdentity() {
  const { t } = useTranslation('common');
  const [params] = useSearchParams();
  const token = params.get('token');

  const [phase, setPhase] = useState<Phase>('loading');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) { setPhase('generic_error'); return; }
      try {
        const { data, error } = await supabase.functions.invoke('verify-identity', {
          body: { token, action: 'list' },
        });
        if (cancelled) return;
        if (error) { setPhase('unavailable'); return; }
        const result = data as { status: string; candidates?: Candidate[] } | null;
        if (result?.status === 'ok') {
          setCandidates(result.candidates ?? []);
          setPhase('choose');
        } else if (result?.status === 'unavailable') {
          setPhase('unavailable');
        } else {
          // invalid / stale / anything else → the uniform generic message (no detail)
          setPhase('generic_error');
        }
      } catch {
        if (!cancelled) {
          logger.warn('verify-identity list failed', { component: 'VerifyIdentity' });
          setPhase('unavailable');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const choose = async (personId: string | null) => {
    if (!token || busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('verify-identity', {
        body: personId
          ? { token, action: 'select', person_id: personId }
          : { token, action: 'select', choose_someone_new: true },
      });
      const result = data as { status: string } | null;
      if (error || result?.status === 'unavailable') { setPhase('unavailable'); return; }
      if (result?.status === 'ok') { setPhase('done'); return; }
      // already_selected is terminal-safe (the choice stands); everything else is generic.
      if (result?.status === 'already_selected') { setPhase('done'); return; }
      setPhase('generic_error');
    } catch {
      setPhase('unavailable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('verifyIdentity.title', 'Bevestig wie je bent')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {phase === 'loading' && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('common:loading', 'Laden…')}
            </div>
          )}

          {phase === 'choose' && (
            <>
              <p className="text-sm text-muted-foreground">
                {t('verifyIdentity.choosePrompt',
                  'Kies wie er boekt, of maak een nieuwe speler aan.')}
              </p>
              <div className="space-y-2">
                {candidates.map((c) => (
                  <Button
                    key={c.person_id}
                    variant="outline"
                    className="w-full justify-start"
                    disabled={busy}
                    onClick={() => choose(c.person_id)}
                  >
                    {c.name}
                  </Button>
                ))}
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={busy}
                  onClick={() => choose(null)}
                >
                  {t('verifyIdentity.someoneNew', 'Iemand anders / nieuwe speler')}
                </Button>
              </div>
            </>
          )}

          {phase === 'done' && (
            <p className="text-sm text-muted-foreground">
              {t('verifyIdentity.done',
                'Bevestigd. Ga terug naar je boeking om die af te ronden.')}
            </p>
          )}

          {phase === 'generic_error' && (
            <p className="text-sm text-muted-foreground">
              {t('verifyIdentity.invalid',
                'Deze link is ongeldig of verlopen. Start je boeking opnieuw.')}
            </p>
          )}

          {phase === 'unavailable' && (
            <p className="text-sm text-muted-foreground">
              {t('verifyIdentity.unavailable',
                'Dit lukt nu even niet. Probeer het zo nog eens.')}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
