import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users, Trash2, Crown, UserPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { useAuth } from "@/hooks/useAuth";
import {
  getUserClubProfiles,
  getClubManagers,
  inviteClubManager,
  removeClubManager,
  ClubProfile,
} from "@/lib/club";
import { ClubNavigation } from "@/components/club/ClubNavigation";

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
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();

  const [club, setClub] = useState<(ClubProfile & { role: string; location: any }) | null>(null);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function loadData() {
      if (!user) return;
      setLoading(true);
      try {
        const clubs = await getUserClubProfiles(user.id);
        if (clubs.length > 0) {
          setClub(clubs[0]);
          const managersData = await getClubManagers(clubs[0].id);
          setManagers(managersData as Manager[]);
        }
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [user]);

  const handleInvite = async () => {
    if (!club || !user || !inviteEmail.trim()) return;

    setInviting(true);
    try {
      const result = await inviteClubManager(club.id, inviteEmail.trim(), user.id);
      if (result.success) {
        toast({
          title: t("managers.inviteSuccess"),
          description: `${inviteEmail} has been invited.`,
        });
        setInviteEmail("");
        setInviteDialogOpen(false);
        // Refresh managers
        const managersData = await getClubManagers(club.id);
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

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8 max-w-2xl">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!club) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8 text-center">
          <p className="text-muted-foreground">{t("dashboard.noClubs", "No clubs found")}</p>
          <Button onClick={() => navigate("/locations")} className="mt-4">
            {t("dashboard.browseLocations", "Browse Locations")}
          </Button>
        </div>
      </div>
    );
  }

  const isOwner = club.role === "owner";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold">{t("settings.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("settings.description")}</p>
        </div>
        <ClubNavigation />
      </div>

      <div className="container mx-auto px-4 py-8 max-w-2xl">
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
    </div>
  );
}
