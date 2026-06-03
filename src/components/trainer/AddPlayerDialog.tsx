import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddPlayerForm } from "./AddPlayerForm";

interface AddPlayerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId?: string;
  academyId?: string;
  onPlayerCreated?: (player: GuestPlayer) => void;
}

export interface GuestPlayer {
  id: string;
  trainer_id: string | null;
  academy_profile_id: string | null;
  first_name: string | null;
  last_name: string | null;
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

export function AddPlayerDialog({
  open,
  onOpenChange,
  trainerId,
  academyId,
  onPlayerCreated,
}: AddPlayerDialogProps) {
  const { t } = useTranslation("trainer");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("players.addPlayer")}</DialogTitle>
          <DialogDescription>
            {t("players.addPlayerDescription")}
          </DialogDescription>
        </DialogHeader>
        <AddPlayerForm
          trainerId={trainerId}
          academyId={academyId}
          onPlayerCreated={(player) => {
            onOpenChange(false);
            onPlayerCreated?.(player);
          }}
          showCancel
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
