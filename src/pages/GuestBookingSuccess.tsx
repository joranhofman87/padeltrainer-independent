import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SEO } from "@/components/SEO";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, AlertCircle, CalendarClock } from "lucide-react";
import { format } from "date-fns";
import { nl, enUS, de, fr, es, it } from "date-fns/locale";
import { useCartOptional } from "@/contexts/cartStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dateLocales: Record<string, any> = { nl, en: enUS, de, fr, es, it };
const getDateLocale = (lang: string) => dateLocales[lang?.slice(0, 2)] ?? nl;

type GuestBookingState = {
  status: "confirmed" | "pending" | "cancelled";
  slotStart: string;
  slotEnd: string;
  cyclusName: string | null;
  amount: number | null;
  sessionCount?: number | null;
};

// Keep the /booking/:token URL out of Referer headers — the token is an
// unguessable handle to the booking (same posture as /pay/:token).
function useNoReferrerMeta() {
  useEffect(() => {
    const prev = document.querySelector('meta[name="referrer"]');
    const prevContent = prev?.getAttribute("content") ?? null;
    let tag = prev as HTMLMetaElement | null;
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "referrer");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", "no-referrer");
    return () => {
      if (prevContent !== null) tag?.setAttribute("content", prevContent);
      else tag?.remove();
    };
  }, []);
}

const POLL_MS = 3000;
const MAX_POLLS = 15; // ~45s of "processing" before we stop nudging the webhook

export default function GuestBookingSuccess() {
  const { token } = useParams<{ token: string }>();
  const { t, i18n } = useTranslation();
  useNoReferrerMeta();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [booking, setBooking] = useState<GuestBookingState | null>(null);
  const pollCount = useRef(0);
  const cart = useCartOptional();

  // A confirmed landing means the payment committed — the cart selection is spent.
  // (Cancel/failure returns land here as "pending" and never clear, so a retry keeps
  // the selection intact.)
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const confirmed = booking?.status === 'confirmed';
  useEffect(() => {
    if (confirmed) cartRef.current?.clearCart();
  }, [confirmed]);

  useEffect(() => {
    if (!token) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetchState = async () => {
      const { data, error } = await supabase.functions.invoke("get-guest-booking", { body: { token } });
      if (cancelled) return;
      const payload = data as (GuestBookingState & { error?: string }) | null;
      if (error || !payload || payload.error || !payload.status) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setBooking(payload);
      setLoading(false);
      // Keep polling while the webhook may still be committing the paid hold.
      if (payload.status === "pending" && pollCount.current < MAX_POLLS) {
        pollCount.current += 1;
        timer = setTimeout(fetchState, POLL_MS);
      }
    };

    fetchState();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const locale = getDateLocale(i18n.language);
  const renderWhen = (b: GuestBookingState) => {
    const start = new Date(b.slotStart);
    const end = new Date(b.slotEnd);
    return `${format(start, "EEEE d MMMM • HH:mm", { locale })}–${format(end, "HH:mm", { locale })}`;
  };

  return (
    <div className="min-h-screen bg-muted/30 flex items-start justify-center px-4 py-10">
      <SEO
        title={t("booking.success.seoTitle", "Je boeking")}
        description={t("booking.success.seoDescription", "Bekijk de status van je training-boeking.")}
        noIndex
      />
      <Card className="w-full max-w-md">
        <CardContent className="p-6 text-center space-y-4">
          {loading ? (
            <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
              <p>{t("booking.success.loading", "Je boeking laden…")}</p>
            </div>
          ) : notFound ? (
            <div className="py-8 flex flex-col items-center gap-3">
              <AlertCircle className="h-10 w-10 text-muted-foreground" aria-hidden />
              <h1 className="text-lg font-semibold">{t("booking.success.notFoundTitle", "Boeking niet gevonden")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("booking.success.notFoundBody", "We konden deze boeking niet vinden. Controleer de link uit je e-mail.")}
              </p>
            </div>
          ) : booking?.status === "confirmed" ? (
            <div className="flex flex-col items-center gap-3">
              <CheckCircle className="h-12 w-12 text-green-600" aria-hidden />
              <h1 className="text-xl font-semibold">{t("booking.success.confirmedTitle", "Je training is geboekt!")}</h1>
              <div className="w-full rounded-lg border bg-background p-4 text-left space-y-1">
                {booking.cyclusName && <p className="font-medium">{booking.cyclusName}</p>}
                {(booking.sessionCount ?? 1) > 1 && (
                  <p className="text-sm text-muted-foreground">
                    {t("booking.success.sessions", "{{count}} sessies", { count: booking.sessionCount })}
                  </p>
                )}
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CalendarClock className="h-4 w-4" aria-hidden />
                  {(booking.sessionCount ?? 1) > 1
                    ? t("booking.success.firstSession", "Eerste sessie: {{when}}", { when: renderWhen(booking) })
                    : renderWhen(booking)}
                </p>
                {booking.amount != null && (
                  <p className="text-sm text-muted-foreground">
                    {t("booking.success.paid", "Betaald")}: €{booking.amount.toFixed(2)}
                  </p>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {t("booking.success.confirmedBody", "Je ontvangt een bevestiging per e-mail. Maak een account aan om je boekingen te beheren.")}
              </p>
              <Button asChild className="w-full" aria-label={t("booking.success.createAccount", "Account aanmaken")}>
                <a href="/signup">{t("booking.success.createAccount", "Account aanmaken")}</a>
              </Button>
            </div>
          ) : booking?.status === "pending" ? (
            <div className="py-8 flex flex-col items-center gap-3">
              <Loader2 className="h-10 w-10 animate-spin text-primary" aria-hidden />
              <h1 className="text-lg font-semibold">{t("booking.success.pendingTitle", "Betaling verwerken…")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("booking.success.pendingBody", "We bevestigen je boeking zodra de betaling binnen is. Dit kan even duren.")}
              </p>
            </div>
          ) : (
            <div className="py-8 flex flex-col items-center gap-3">
              <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
              <h1 className="text-lg font-semibold">{t("booking.success.cancelledTitle", "Boeking niet voltooid")}</h1>
              <p className="text-sm text-muted-foreground">
                {t("booking.success.cancelledBody", "Deze boeking is niet betaald of is verlopen. Je plek is weer vrijgegeven — probeer opnieuw te boeken.")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
