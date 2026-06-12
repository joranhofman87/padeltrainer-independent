import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  checkClubSubscription, 
  createClubCheckout, 
  getTrialDaysRemaining,
  type ClubSubscriptionInfo 
} from "@/lib/clubSubscription";
import { useClubPlan } from "@/hooks/usePricingPlans";
import { getUserClubProfiles, type ClubProfile } from "@/lib/club";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { formatDate } from '@/lib/format';
import { 
  CheckCircle2, 
  Clock, 
  CreditCard, 
  AlertTriangle,
  Building2,
  Users,
  Calendar,
  BarChart3,
  Sparkles,
  ExternalLink
} from "lucide-react";

export default function ClubSubscription() {
  const { t } = useTranslation(["club", "common"]);
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  const [_clubs, setClubs] = useState<(ClubProfile & { role: string; location: any })[]>([]);
  const [activeClub, setActiveClub] = useState<(ClubProfile & { role: string; location: any }) | null>(null);
  const [subscription, setSubscription] = useState<ClubSubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const { data: plan, isLoading: planLoading } = useClubPlan();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/app/auth?redirect=/app/club/subscription");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    async function loadData() {
      if (!user) return;
      
      try {
        const userClubs = await getUserClubProfiles(user.id);
        setClubs(userClubs);
        
        if (userClubs.length > 0) {
          setActiveClub(userClubs[0]);
        }
      } catch (error) {
        logger.error("Error loading clubs", error instanceof Error ? error : new Error(String(error)), { component: 'ClubSubscription' });
      } finally {
        setLoading(false);
      }
    }
    
    loadData();
  }, [user]);

  useEffect(() => {
    async function loadSubscription() {
      if (!activeClub) return;
      
      try {
        const sub = await checkClubSubscription(activeClub.id);
        setSubscription(sub);
      } catch (error) {
        logger.error("Error loading subscription", error instanceof Error ? error : new Error(String(error)), { component: 'ClubSubscription' });
      }
    }
    
    loadSubscription();
  }, [activeClub]);

  useEffect(() => {
    if (searchParams.get("success") === "true") {
      toast({
        title: t("subscription.successTitle"),
        description: t("subscription.successDescription"),
      });
    } else if (searchParams.get("canceled") === "true") {
      toast({
        title: t("subscription.canceledTitle"),
        description: t("subscription.canceledDescription"),
        variant: "destructive",
      });
    }
  }, [searchParams, toast, t]);

  const handleSubscribe = async () => {
    if (!activeClub) return;
    
    setActionLoading(true);
    try {
      const url = await createClubCheckout(activeClub.id);
      window.location.href = url;
    } catch (error: any) {
      toast({
        title: t("common:error"),
        description: getFriendlyErrorMessage(error, t("subscription.checkoutError", "Could not start checkout. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    if (!activeClub) return;
    
    setActionLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      
      const response = await supabase.functions.invoke("customer-portal", {
        body: { type: "club", profileId: activeClub.id },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      
      if (response.error) throw new Error(response.error.message);
      
      if (response.data?.url) {
        window.open(response.data.url, '_blank');
      }
    } catch (error: any) {
      toast({
        title: t("common:error"),
        description: getFriendlyErrorMessage(error, t("subscription.portalError", "Could not open subscription management. Please try again.")),
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  if (authLoading || loading || planLoading) {
    return (
      <div className="min-h-screen bg-background p-4 md:p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!activeClub) {
    return (
      <div className="min-h-screen bg-background p-4 md:p-8">
        <div className="max-w-4xl mx-auto text-center py-12">
          <Building2 className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t("noClubs")}</h1>
          <p className="text-muted-foreground mb-6">{t("noClubsDescription")}</p>
          <Button onClick={() => navigate("/locations")}>
            {t("browseLocations")}
          </Button>
        </div>
      </div>
    );
  }

  const trialDays = subscription?.trialEnd ? getTrialDaysRemaining(subscription.trialEnd) : 0;
  const isTrialing = subscription?.isTrial && !subscription?.trialExpired;
  const isActive = subscription?.isSubscribed && !subscription?.isTrial;
  const isExpired = subscription?.trialExpired && !subscription?.isSubscribed;

  const features = [
    { icon: Users, label: t("subscription.features.unlimitedTrainers") },
    { icon: Calendar, label: t("subscription.features.unifiedCalendar") },
    { icon: BarChart3, label: t("subscription.features.analytics") },
    { icon: Sparkles, label: t("subscription.features.prioritySupport") },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">

        {/* Trial Banner */}
        {isTrialing && (
          <Alert className="border-primary bg-primary/5">
            <Clock className="h-4 w-4" />
            <AlertTitle>{t("subscription.trialActive")}</AlertTitle>
            <AlertDescription>
              {t("subscription.trialDaysRemaining", { days: trialDays })}
            </AlertDescription>
          </Alert>
        )}

        {/* Expired Banner */}
        {isExpired && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("subscription.trialExpired")}</AlertTitle>
            <AlertDescription>
              {t("subscription.subscribeToAccess")}
            </AlertDescription>
          </Alert>
        )}

        {/* Subscription Status Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {plan?.name ?? "Club Plan"}
                  {isActive && (
                    <Badge className="bg-emerald-500">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {t("subscription.active")}
                    </Badge>
                  )}
                  {isTrialing && (
                    <Badge variant="secondary">
                      <Clock className="h-3 w-3 mr-1" />
                      {t("subscription.trial")}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {t("subscription.description")}
                </CardDescription>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold">€{plan?.monthly_price ?? 19}</div>
                <div className="text-sm text-muted-foreground">{t("subscription.perMonth")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("subscription.billedAnnually", { amount: plan?.yearly_price ?? 2388 })}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Features */}
            <div className="grid grid-cols-2 gap-4">
              {features.map((feature, i) => (
                <div key={i} className="flex items-center gap-2">
                  <feature.icon className="h-5 w-5 text-primary" />
                  <span className="text-sm">{feature.label}</span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3 pt-4 border-t">
              {!isActive && (
                <Button 
                  onClick={handleSubscribe} 
                  disabled={actionLoading}
                  className="flex-1"
                >
                  <CreditCard className="h-4 w-4 mr-2" />
                  {isTrialing 
                    ? t("subscription.upgradeNow")
                    : t("subscription.startTrial")
                  }
                </Button>
              )}
              
              {(isActive || subscription?.isSubscribed) && (
                <Button 
                  variant="outline" 
                  onClick={handleManageSubscription}
                  disabled={actionLoading}
                  className="flex-1"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t("subscription.manageSubscription", "Manage Subscription")}
                </Button>
              )}
            </div>

            {/* Subscription Details */}
            {subscription?.subscriptionEnd && (
              <div className="text-sm text-muted-foreground pt-2">
                {isActive
                  ? t("subscription.renewsOn", {
                      date: formatDate(subscription.subscriptionEnd)
                    })
                  : t("subscription.endsOn", {
                      date: formatDate(subscription.subscriptionEnd)
                    })
                }
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
