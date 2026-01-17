import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, CheckCircle2 } from "lucide-react";
import { RATING_SYSTEMS, RatingSystem, getRatingSystemConfig, DEFAULT_RATING_SYSTEM } from "@/lib/ratingSystem";

interface AddPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  onPlayerCreated?: (player: GuestPlayer) => void;
}

export interface GuestPlayer {
  id: string;
  trainer_id: string;
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  linked_profile_id: string | null;
}

interface LinkedProfile {
  id: string;
  full_name: string | null;
  skill_rating: number | null;
}

export function AddPlayerDialog({
  open,
  onOpenChange,
  trainerId,
  onPlayerCreated,
}: AddPlayerDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [ratingSystem, setRatingSystem] = useState<RatingSystem>(DEFAULT_RATING_SYSTEM);
  const [skillRating, setSkillRating] = useState("");
  const [notes, setNotes] = useState("");
  const [linkedProfile, setLinkedProfile] = useState<LinkedProfile | null>(null);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);

  const resetForm = () => {
    setFullName("");
    setEmail("");
    setPhone("");
    setRatingSystem(DEFAULT_RATING_SYSTEM);
    setSkillRating("");
    setNotes("");
    setLinkedProfile(null);
  };

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  };

  const handleEmailBlur = async () => {
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !validateEmail(trimmedEmail)) {
      setLinkedProfile(null);
      return;
    }

    setIsCheckingEmail(true);
    try {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, skill_rating, rating_system")
        .eq("email", trimmedEmail)
        .maybeSingle();

      if (data) {
        setLinkedProfile(data);
        // Auto-fill skill rating and system if empty and profile has it
        if (!skillRating && data.skill_rating) {
          const profileRatingSystem = (data.rating_system as RatingSystem) || DEFAULT_RATING_SYSTEM;
          setRatingSystem(profileRatingSystem);
          setSkillRating(data.skill_rating.toString());
          toast({
            title: t("players.autoFilledFromProfile"),
            description: `${t("players.skillRating")}: ${data.skill_rating.toFixed(1)} (${profileRatingSystem.toUpperCase()})`,
          });
        }
      } else {
        setLinkedProfile(null);
      }
    } catch (error) {
      console.error("Error checking email:", error);
      setLinkedProfile(null);
    } finally {
      setIsCheckingEmail(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("guest_players")
        .insert({
          trainer_id: trainerId,
          full_name: fullName.trim(),
          email: email.trim().toLowerCase() || "",
          phone: phone.trim() || "",
          skill_rating: skillRating ? parseFloat(skillRating) : null,
          rating_system: ratingSystem,
          notes: notes.trim() || null,
          linked_profile_id: linkedProfile?.id || null,
        })
        .select()
        .single();

      if (error) {
        // Handle unique constraint violation
        if (error.code === "23505") {
          toast({
            title: t("players.duplicateEmail"),
            description: t("players.duplicateEmailDescription"),
            variant: "destructive",
          });
          return;
        }
        throw error;
      }

      toast({
        title: t("players.playerCreated"),
        description: t("players.playerCreatedDescription", { name: fullName }),
      });

      resetForm();
      onOpenChange(false);
      onPlayerCreated?.(data as GuestPlayer);
    } catch (error: any) {
      console.error("Error creating player:", error);
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("players.addPlayer")}</DialogTitle>
          <DialogDescription>
            {t("players.addPlayerDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fullName">{t("players.fullName")} *</Label>
            <Input
              id="fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t("players.fullNamePlaceholder")}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">{t("players.email")} *</Label>
            <div className="relative">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setLinkedProfile(null);
                }}
                onBlur={handleEmailBlur}
                placeholder={t("players.emailPlaceholder")}
                required
              />
              {isCheckingEmail && (
                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            {linkedProfile && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-sm">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <div>
                  <span className="font-medium">{t("players.linkedToProfile")}</span>
                  {linkedProfile.full_name && (
                    <span className="ml-1">"{linkedProfile.full_name}"</span>
                  )}
                  {linkedProfile.skill_rating && (
                    <span className="text-green-600 dark:text-green-400 ml-1">
                      • {t("players.skillRating")}: {linkedProfile.skill_rating.toFixed(1)}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">{t("players.phone")}</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("players.phonePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="skillRating">{t("players.skillRating")}</Label>
            <div className="flex items-center gap-2">
              <Select
                value={ratingSystem}
                onValueChange={(value: RatingSystem) => {
                  setRatingSystem(value);
                  setSkillRating("");
                }}
              >
                <SelectTrigger className="w-32 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(RATING_SYSTEMS).map((system) => (
                    <SelectItem key={system.id} value={system.id}>
                      {system.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="skillRating"
                type="number"
                step={getRatingSystemConfig(ratingSystem).step}
                min={getRatingSystemConfig(ratingSystem).min}
                max={getRatingSystemConfig(ratingSystem).max}
                value={skillRating}
                onChange={(e) => setSkillRating(e.target.value)}
                placeholder={`${getRatingSystemConfig(ratingSystem).min} - ${getRatingSystemConfig(ratingSystem).max}`}
                className="flex-1"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">{t("players.notes")}</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("players.notesPlaceholder")}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
            >
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("players.addPlayer")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
