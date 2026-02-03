import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { 
  Users, 
  Trash2, 
  Crown, 
  UserPlus, 
  Loader2, 
  CreditCard,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Wallet
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useClubContext } from "@/components/club/ClubLayout";
import {
  getClubManagers,
  inviteClubManager,
  removeClubManager,
} from "@/lib/club";
import { 
  connectClubMollie, 
  checkClubConnectStatus,
  type ClubConnectStatus 
} from "@/lib/clubPayments";

interface Manager {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
  profile: {
    full_name: string | null;
    email: string | null;
    avatar_url: string | null;
  } | null;
}

export default function ClubSettings() {
  const { t } = useTranslation("club");
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { activeClub } = useClubContext();

  const [managers, setManagers] = useState<Manager[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  
  // Mollie Connect state
  const [connectStatus, setConnectStatus] = useState<ClubConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);

  useEffect(() => {
    async function loadData() {
      if (!activeClub) return;
      setLoading(true);
      try {
        const managersData = await getClubManagers(activeClub.id);
        setManagers(managersData as Manager[]);
        
        // Check Mollie connect status
        setCheckingStatus(true);
        try {
          const status = await checkClubConnectStatus(activeClub.id);
          setConnectStatus(status);
        } catch (e) {
          console.error("Error checking connect status:", e);
        } finally {
          setCheckingStatus(false);
        }
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [activeClub]);

  // Handle Mollie redirect callbacks
  useEffect(() => {
    if (searchParams.get("mollie_success") === "true" && activeClub) {
      toast({
        title: t("settings.mollieConnectSuccess", "Payment Account Connected"),
        description: t("settings.mollieConnectSuccessDescription", "Your payment account has been connected successfully."),
      });
      // Refresh status
      checkClubConnectStatus(activeClub.id).then(setConnectStatus).catch(console.error);
    } else if (searchParams.get("mollie_refresh") === "true") {
      toast({
        title: t("settings.mollieConnectRefresh", "Complete Setup"),
        description: t("settings.mollieConnectRefreshDescription", "Please complete your payment account setup."),
        variant: "destructive",
      });
    }
  }, [searchParams, activeClub, toast, t]);

  const handleConnectMollie = async () => {
    if (!activeClub) return;
    
    setConnectLoading(true);
    try {
      const url = await connectClubMollie(activeClub.id);
      window.open(url, "_blank");
    } catch (error: any) {
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setConnectLoading(false);
    }
  };

  const handleRefreshStatus = async () => {
    if (!activeClub) return;
    
    setCheckingStatus(true);
    try {
      const status = await checkClubConnectStatus(activeClub.id);
      setConnectStatus(status);
      toast({
        title: t("settings.statusRefreshed", "Status Refreshed"),
        description: t("settings.statusRefreshedDescription", "Connection status has been updated."),
      });
    } catch (error: any) {
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleInvite = async () => {
    if (!activeClub || !inviteEmail.trim()) return;

    setInviting(true);
    try {
      // Use empty string as we don't have user context here - the backend should handle this
      const result = await inviteClubManager(activeClub.id, inviteEmail.trim(), "");
      if (result.success) {
        toast({
          title: t("managers.inviteSuccess"),
          description: `${inviteEmail} has been invited.`,
        });
        setInviteEmail("");
        setInviteDialogOpen(false);
        // Refresh managers
        const managersData = await getClubManagers(activeClub.id);
        setManagers(managersData as Manager[]);
      } else {
        toast({
          title: t("managers.inviteError"),
          description: result.error || "Unknown error",
          variant: "destructive",
        });
      }
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveManager = async (managerId: string) => {
    const success = await removeClubManager(managerId);
    if (success) {
      setManagers((prev) => prev.filter((m) => m.id !== managerId));
      toast({
        title: "Manager removed",
        description: "The manager has been removed from the club.",
      });
    } else {
      toast({
        title: "Error",
        description: "Failed to remove manager.",
        variant: "destructive",
      });
    }
  };

  const getInitials = (name: string | null) => {
    if (!name) return "?";
    return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-64 w-full mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const isOwner = activeClub?.role === "owner";

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl space-y-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t("settings.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
      </div>
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
              {t("settings.mollieConnectDescription", "Connect your payment account to receive payments from club trainer bookings.")}
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
                    {t("settings.notConnectedDescription", "Connect your payment account to receive payments when players book with your club trainers.")}
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

        {/* Managers Card */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-lg">{t("managers.title")}</CardTitle>
              </div>
              {isOwner && (
                <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <UserPlus className="h-4 w-4 mr-2" />
                      {t("managers.invite")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("managers.invite")}</DialogTitle>
                      <DialogDescription>{t("managers.inviteDescription")}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="email">{t("managers.email")}</Label>
                        <Input
                          id="email"
                          type="email"
                          placeholder="manager@example.com"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setInviteDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                        {inviting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {t("managers.invite")}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
            <CardDescription>{t("managers.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {managers.map((manager) => (
                <div
                  key={manager.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card"
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={manager.profile?.avatar_url || undefined} />
                      <AvatarFallback>
                        {getInitials(manager.profile?.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {manager.profile?.full_name || "Unknown"}
                        </span>
                        {manager.role === "owner" && (
                          <Badge variant="secondary" className="flex items-center gap-1">
                            <Crown className="h-3 w-3" />
                            {t("managers.owner")}
                          </Badge>
                        )}
                        {manager.role === "manager" && (
                          <Badge variant="outline">{t("managers.manager")}</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {manager.profile?.email || "No email"}
                      </p>
                    </div>
                  </div>
                  {isOwner && manager.role !== "owner" && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("managers.removeConfirm")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("managers.removeConfirmDescription")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleRemoveManager(manager.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {t("managers.remove")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
      </Card>
    </div>
  );
}
