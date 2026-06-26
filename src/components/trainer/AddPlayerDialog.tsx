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

// GuestPlayer now lives in the neutral players domain; imported for local use
// and re-exported so existing `from '.../AddPlayerDialog'` importers keep working.
import type { GuestPlayer } from '@/components/players/guestPlayer';
export type { GuestPlayer };

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
