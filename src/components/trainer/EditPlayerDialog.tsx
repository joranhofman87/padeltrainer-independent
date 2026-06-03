import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import { buildGuestPlayerDbFields, prefillGuestNameFields } from "@/lib/profileName";
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
import { Loader2 } from "lucide-react";
import { GuestPlayer } from "./AddPlayerDialog";
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from "@/lib/ratingSystems";

interface EditPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  player: GuestPlayer;
  onPlayerUpdated?: (player: GuestPlayer) => void;
}

export function EditPlayerDialog({
  open,
  onOpenChange,
  player,
  onPlayerUpdated,
}: EditPlayerDialogProps) {
  const { t } = useTranslation("trainer");
  const { toast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState(player.email || "");
  const [phone, setPhone] = useState(player.phone || "");
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [ratingSystem, setRatingSystem] = useState<string>(player.rating_system || "knltb");
  const [skillRating, setSkillRating] = useState(
    player.skill_rating?.toString() || ""
  );
  const [notes, setNotes] = useState(player.notes || "");
  const [loadingRatingSystems, setLoadingRatingSystems] = useState(true);

  useEffect(() => {
    async function fetchRatingSystems() {
      setLoadingRatingSystems(true);
      try {
        const systems = await getRatingSystems();
        setRatingSystems(systems);
      } catch (error) {
        logger.error("Error fetching rating systems", error instanceof Error ? error : new Error(String(error)), { component: 'EditPlayerDialog' });
      } finally {
        setLoadingRatingSystems(false);
      }
    }
    fetchRatingSystems();
  }, []);

  useEffect(() => {
    const prefilled = prefillGuestNameFields(player);
    setFirstName(prefilled.first_name);
    setLastName(prefilled.last_name);
    setEmail(player.email || "");
    setPhone(player.phone || "");
    setRatingSystem(player.rating_system || "knltb");
    setSkillRating(player.skill_rating?.toString() || "");
    setNotes(player.notes || "");
  }, [player]);

  const currentRatingSystem = ratingSystems.find(s => s.code === ratingSystem);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameFields = buildGuestPlayerDbFields(firstName, lastName);
    if (!nameFields.full_name) {
      toast({
        title: t("common:error"),
        description: t("players.firstName") + " *",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("guest_players")
        .update({
          ...nameFields,
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          skill_rating: skillRating ? parseFloat(skillRating) : null,
          rating_system: ratingSystem,
          notes: notes.trim() || null,
        })
        .eq("id", player.id)
        .select()
        .single();

      if (error) throw error;

      toast({
        title: t("players.playerUpdated"),
        description: t("players.playerUpdatedDescription"),
      });

      onOpenChange(false);
      onPlayerUpdated?.(data as GuestPlayer);
    } catch (error: any) {
      logger.error("Error updating player", error instanceof Error ? error : new Error(String(error)), { component: 'EditPlayerDialog' });
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

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
          <DialogTitle>{t("players.editPlayer")}</DialogTitle>
          <DialogDescription>
            {t("players.editPlayerDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-firstName">{t("players.firstName")} *</Label>
              <Input
                id="edit-firstName"
                name="firstName"
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t("players.firstNamePlaceholder")}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-lastName">{t("players.lastName")}</Label>
              <Input
                id="edit-lastName"
                name="lastName"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t("players.lastNamePlaceholder")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-email">{t("players.email")}</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("players.emailPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-phone">{t("players.phone")}</Label>
            <Input
              id="edit-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("players.phonePlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-ratingSystem">{t("players.ratingSystem")}</Label>
            <Select
              value={ratingSystem}
              onValueChange={(value) => {
                setRatingSystem(value);
                setSkillRating("");
              }}
              disabled={loadingRatingSystems}
            >
              <SelectTrigger id="edit-ratingSystem">
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
                        {system.name} ({system.min_rating} - {system.max_rating})
                      </SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-skillRating">{t("players.skillRating")}</Label>
            <Input
              id="edit-skillRating"
              type="number"
              step={currentRatingSystem?.step || 0.1}
              min={currentRatingSystem?.min_rating || 0.1}
              max={currentRatingSystem?.max_rating || 10}
              value={skillRating}
              onChange={(e) => setSkillRating(e.target.value)}
              placeholder={t("players.skillRatingPlaceholder")}
              disabled={!currentRatingSystem}
            />
            {currentRatingSystem && (
              <p className="text-xs text-muted-foreground">
                {currentRatingSystem.min_rating} - {currentRatingSystem.max_rating}
                {currentRatingSystem.lower_is_better && ' (lower is better)'}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-notes">{t("players.notes")}</Label>
            <Textarea
              id="edit-notes"
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
              {t("players.saveChanges")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Build guest_players update payload (exported for tests). */
export function buildEditPlayerUpdatePayload(firstName: string, lastName: string) {
  return buildGuestPlayerDbFields(firstName, lastName);
}
