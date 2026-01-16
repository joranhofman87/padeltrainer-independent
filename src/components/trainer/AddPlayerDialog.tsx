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
import { Loader2 } from "lucide-react";

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
  notes: string | null;
  created_at: string;
  updated_at: string;
  linked_profile_id: string | null;
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
  const [skillRating, setSkillRating] = useState("");
  const [notes, setNotes] = useState("");

  const resetForm = () => {
    setFullName("");
    setEmail("");
    setPhone("");
    setSkillRating("");
    setNotes("");
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
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          skill_rating: skillRating ? parseFloat(skillRating) : null,
          notes: notes.trim() || null,
        })
        .select()
        .single();

      if (error) throw error;

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
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("players.emailPlaceholder")}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">{t("players.phone")} *</Label>
            <Input
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t("players.phonePlaceholder")}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="skillRating">{t("players.skillRating")}</Label>
            <Input
              id="skillRating"
              type="number"
              step="0.1"
              min="1"
              max="10"
              value={skillRating}
              onChange={(e) => setSkillRating(e.target.value)}
              placeholder={t("players.skillRatingPlaceholder")}
            />
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
