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
import { Loader2 } from "lucide-react";
import { GuestPlayer } from "./AddPlayerDialog";
import { RATING_SYSTEMS, RatingSystem, getRatingSystemConfig, DEFAULT_RATING_SYSTEM } from "@/lib/ratingSystem";

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
  const [fullName, setFullName] = useState(player.full_name);
  const [email, setEmail] = useState(player.email);
  const [phone, setPhone] = useState(player.phone);
  const [ratingSystem, setRatingSystem] = useState<RatingSystem>(
    (player.rating_system as RatingSystem) || DEFAULT_RATING_SYSTEM
  );
  const [skillRating, setSkillRating] = useState(
    player.skill_rating?.toString() || ""
  );
  const [notes, setNotes] = useState(player.notes || "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("guest_players")
        .update({
          full_name: fullName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
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
      console.error("Error updating player:", error);
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
          <DialogTitle>{t("players.editPlayer")}</DialogTitle>
          <DialogDescription>
            {t("players.editPlayerDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-fullName">{t("players.fullName")} *</Label>
            <Input
              id="edit-fullName"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t("players.fullNamePlaceholder")}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-email">{t("players.email")} *</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("players.emailPlaceholder")}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-phone">{t("players.phone")} *</Label>
            <Input
              id="edit-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("players.phonePlaceholder")}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-ratingSystem">{t("players.ratingSystem")}</Label>
            <Select
              value={ratingSystem}
              onValueChange={(value: RatingSystem) => {
                setRatingSystem(value);
                setSkillRating("");
              }}
            >
              <SelectTrigger id="edit-ratingSystem">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(RATING_SYSTEMS).map((system) => (
                  <SelectItem key={system.id} value={system.id}>
                    {system.name} ({system.min} - {system.max})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-skillRating">{t("players.skillRating")}</Label>
            <Input
              id="edit-skillRating"
              type="number"
              step={getRatingSystemConfig(ratingSystem).step}
              min={getRatingSystemConfig(ratingSystem).min}
              max={getRatingSystemConfig(ratingSystem).max}
              value={skillRating}
              onChange={(e) => setSkillRating(e.target.value)}
              placeholder={t("players.skillRatingPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">
              {getRatingSystemConfig(ratingSystem).min} - {getRatingSystemConfig(ratingSystem).max}
            </p>
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
