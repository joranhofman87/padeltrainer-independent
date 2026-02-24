import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { 
  Users, 
  Trash2, 
  Crown, 
  UserPlus, 
  Loader2,
  Globe,
  MessageSquare
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useClubContext } from "@/components/club/ClubLayout";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabaseClient";
import {
  getClubManagers,
  inviteClubManager,
  removeClubManager,
} from "@/lib/club";
import { DeleteAccountDialog } from "@/components/settings/DeleteAccountDialog";

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
  const { t, i18n } = useTranslation("club");
  const { toast } = useToast();
  const { activeClub } = useClubContext();
  const { user } = useAuth();

  const [managers, setManagers] = useState<Manager[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [savingWelcome, setSavingWelcome] = useState(false);

  useEffect(() => {
    async function loadData() {
      if (!activeClub) return;
      setLoading(true);
      try {
        const [managersData, clubData] = await Promise.all([
          getClubManagers(activeClub.id),
          supabase.from('club_profiles').select('welcome_message').eq('id', activeClub.id).maybeSingle(),
        ]);
        setManagers(managersData as Manager[]);
        if (clubData.data?.welcome_message) {
          setWelcomeMessage(clubData.data.welcome_message);
        }
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [activeClub]);

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

  const handleSaveWelcomeMessage = async () => {
    if (!activeClub) return;
    setSavingWelcome(true);
    try {
      const { error } = await supabase
        .from('club_profiles')
        .update({ welcome_message: welcomeMessage.trim() || null } as any)
        .eq('id', activeClub.id);
      if (error) throw error;
      toast({ title: t('settings.welcomeMessageSaved') });
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setSavingWelcome(false);
    }
  };

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <Skeleton className="h-8 w-48 mb-4" />
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
                        <AlertDialogTitle>{t("managers.removeTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("managers.removeDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleRemoveManager(manager.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
            {managers.length === 0 && (
              <p className="text-center text-muted-foreground py-4">
                No managers found
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Welcome Message */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg">{t("settings.welcomeMessage")}</CardTitle>
          </div>
          <CardDescription>{t("settings.welcomeMessageDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            placeholder={t("settings.welcomeMessagePlaceholder")}
            rows={4}
            maxLength={1000}
          />
          <div className="flex justify-end">
            <Button onClick={handleSaveWelcomeMessage} disabled={savingWelcome}>
              {savingWelcome && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Language Setting */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-500/10">
              <Globe className="h-5 w-5 text-indigo-600" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg">{t("settings.language", "Language")}</CardTitle>
              <CardDescription>{t("settings.languageDescription", "Choose your preferred language for the app")}</CardDescription>
            </div>
            <Select
              value={i18n.language}
              onValueChange={async (value) => {
                i18n.changeLanguage(value);
                if (user) {
                  await supabase.from('profiles').update({ preferred_language: value } as any).eq('user_id', user.id);
                }
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nl">🇳🇱 Nederlands</SelectItem>
                <SelectItem value="en">🇬🇧 English</SelectItem>
                <SelectItem value="es">🇪🇸 Español</SelectItem>
                <SelectItem value="de">🇩🇪 Deutsch</SelectItem>
                <SelectItem value="fr">🇫🇷 Français</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
      </Card>

      {/* Danger Zone */}
      <div className="pt-6 border-t border-destructive/20">
        <h3 className="text-lg font-semibold text-destructive mb-4">{t("settings.dangerZone", "Danger Zone")}</h3>
        <DeleteAccountDialog />
      </div>
    </div>
  );
}
