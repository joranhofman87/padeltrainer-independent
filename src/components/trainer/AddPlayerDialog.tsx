import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { logger } from '@/lib/logger';
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
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from "@/lib/ratingSystems";

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
  rating_system?: string;
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
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [ratingSystem, setRatingSystem] = useState<string>("knltb");
  const [skillRating, setSkillRating] = useState("");
  const [notes, setNotes] = useState("");
  const [linkedProfile, setLinkedProfile] = useState<LinkedProfile | null>(null);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);
  const [loadingRatingSystems, setLoadingRatingSystems] = useState(true);

  // Fetch rating systems on mount
  useEffect(() => {
    async function fetchRatingSystems() {
      setLoadingRatingSystems(true);
      try {
        const systems = await getRatingSystems();
        setRatingSystems(systems);
        if (systems.length > 0 && !systems.find(s => s.code === ratingSystem)) {
          setRatingSystem(systems[0].code);
        }
      } catch (error) {
        logger.error('Error fetching rating systems', error as Error, { component: 'AddPlayerDialog' });
      } finally {
        setLoadingRatingSystems(false);
      }
    }
    fetchRatingSystems();
  }, []);

  const currentRatingSystem = ratingSystems.find(s => s.code === ratingSystem);

  const resetForm = () => {
    setFullName("");
    setEmail("");
    setPhone("");
    setRatingSystem("knltb");
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
          const profileRatingSystem = data.rating_system || "knltb";
          setRatingSystem(profileRatingSystem);
          setSkillRating(data.skill_rating.toString());
          const systemConfig = ratingSystems.find(s => s.code === profileRatingSystem);
          toast({
            title: t("players.autoFilledFromProfile"),
            description: `${t("players.skillRating")}: ${data.skill_rating.toFixed(1)} (${systemConfig?.name || profileRatingSystem.toUpperCase()})`,
          });
        }
      } else {
        setLinkedProfile(null);
      }
    } catch (error) {
      logger.warn('Error checking email', { error, component: 'AddPlayerDialog' });
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
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
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
      logger.error('Error creating player', error as Error, { component: 'AddPlayerDialog' });
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Group rating systems by country
  const groupedSystems = ratingSystems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) acc[country] = [];
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);

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
            <Label htmlFor="email">{t("players.email")}</Label>
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
                onValueChange={(value) => {
                  setRatingSystem(value);
                  setSkillRating("");
                }}
                disabled={loadingRatingSystems}
              >
                <SelectTrigger className="w-36 shrink-0">
                  <SelectValue placeholder={loadingRatingSystems ? "Loading..." : "Select"} />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(groupedSystems).map(([country, systems]) => (
                    <div key={country}>
                      <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                        {COUNTRY_NAMES[country] || country}
                      </div>
                      {systems.map((system) => (
                        <SelectItem key={system.code} value={system.code}>
                          {system.name}
                        </SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="skillRating"
                type="number"
                step={currentRatingSystem?.step || 0.1}
                min={currentRatingSystem?.min_rating || 0.1}
                max={currentRatingSystem?.max_rating || 10}
                value={skillRating}
                onChange={(e) => setSkillRating(e.target.value)}
                placeholder={currentRatingSystem ? `${currentRatingSystem.min_rating} - ${currentRatingSystem.max_rating}` : ""}
                className="flex-1"
                disabled={!currentRatingSystem}
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
