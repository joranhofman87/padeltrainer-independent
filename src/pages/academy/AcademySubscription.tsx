import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  checkAcademySubscription, 
  createAcademyCheckout, 
  cancelAcademySubscription,
  getTrialDaysRemaining,
  ACADEMY_SUBSCRIPTION,
  type AcademySubscriptionInfo 
} from "@/lib/academySubscription";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { useToast } from "@/hooks/use-toast";
import { 
  CheckCircle2, 
  Clock, 
  CreditCard, 
  AlertTriangle,
  GraduationCap,
  Users,
  MapPin,
  BarChart3,
  Sparkles
} from "lucide-react";
import { logger } from "@/lib/logger";

export default function AcademySubscription() {
  const { t } = useTranslation(["academy", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { activeAcademy, refreshAcademies } = useAcademyContext();

  const [subscription, setSubscription] = useState<AcademySubscriptionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    async function loadSubscription() {
      if (!activeAcademy) return;
      
      try {
        const sub = await checkAcademySubscription(activeAcademy.id);
        setSubscription(sub);
      } catch (error) {
        logger.error("Error loading subscription", error as Error, { component: "AcademySubscription", academyId: activeAcademy?.id });
      } finally {
        setLoading(false);
      }
    }
    
    loadSubscription();
  }, [activeAcademy]);

  useEffect(() => {
    if (searchParams.get("success") === "true") {
      toast({
        title: t("subscription.successTitle"),
        description: t("subscription.successDescription"),
      });
      // Refresh subscription status
      if (activeAcademy) {
        checkAcademySubscription(activeAcademy.id).then(setSubscription);
        refreshAcademies();
      }
    } else if (searchParams.get("canceled") === "true") {
      toast({
        title: t("subscription.canceledTitle"),
        description: t("subscription.canceledDescription"),
        variant: "destructive",
      });
    }
  }, [searchParams, toast, t, activeAcademy, refreshAcademies]);

  const handleSubscribe = async () => {
    if (!activeAcademy) return;
    
    setActionLoading(true);
    try {
      const url = await createAcademyCheckout(activeAcademy.id);
      window.location.href = url;
    } catch (error: any) {
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (!activeAcademy) return;
    
    setActionLoading(true);
    try {
      const result = await cancelAcademySubscription(activeAcademy.id);
      toast({
        title: t("subscription.canceledTitle"),
        description: result.message,
      });
      // Refresh subscription status
      const sub = await checkAcademySubscription(activeAcademy.id);
      setSubscription(sub);
    } catch (error: any) {
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!activeAcademy) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto text-center py-12">
          <GraduationCap className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t("dashboard.noAcademies")}</h1>
          <Button onClick={() => navigate("/academy/onboarding")}>
            {t("dashboard.createAcademy")}
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
    { icon: MapPin, label: t("subscription.features.multipleLocations") },
    { icon: BarChart3, label: t("subscription.features.analytics") },
    { icon: Sparkles, label: t("subscription.features.prioritySupport") },
  ];

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto space-y-6">

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
                  {ACADEMY_SUBSCRIPTION.name}
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
                <div className="text-3xl font-bold">€{ACADEMY_SUBSCRIPTION.monthlyPrice}</div>
                <div className="text-sm text-muted-foreground">{t("subscription.perMonth")}</div>
                <div className="text-xs text-muted-foreground">
                  {t("subscription.billedAnnually", { amount: ACADEMY_SUBSCRIPTION.yearlyPrice })}
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
                  onClick={handleCancelSubscription}
                  disabled={actionLoading}
                  className="flex-1"
                >
                  {t("subscription.cancelSubscription")}
                </Button>
              )}
            </div>

            {/* Subscription Details */}
            {subscription?.subscriptionEnd && (
              <div className="text-sm text-muted-foreground pt-2">
                {isActive 
                  ? t("subscription.renewsOn", { 
                      date: new Date(subscription.subscriptionEnd).toLocaleDateString() 
                    })
                  : t("subscription.endsOn", { 
                      date: new Date(subscription.subscriptionEnd).toLocaleDateString() 
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
