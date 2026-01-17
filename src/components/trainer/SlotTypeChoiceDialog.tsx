import { useTranslation } from "react-i18next";
import { CalendarPlus, Repeat } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface SlotTypeChoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseSingleSlot: () => void;
  onChooseCyclus: () => void;
}

export function SlotTypeChoiceDialog({
  open,
  onOpenChange,
  onChooseSingleSlot,
  onChooseCyclus,
}: SlotTypeChoiceDialogProps) {
  const { t } = useTranslation("trainer");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("calendar.chooseSlotType", "What would you like to create?")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-4">
          <Button
            variant="outline"
            className="h-32 flex flex-col items-center justify-center gap-3 hover:border-primary hover:bg-primary/5"
            onClick={() => {
              onOpenChange(false);
              onChooseSingleSlot();
            }}
          >
            <CalendarPlus className="h-8 w-8 text-primary" />
            <div className="text-center">
              <div className="font-medium">{t("calendar.singleSlot", "Single Slot")}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t("calendar.singleSlotDesc", "One-time availability")}
              </div>
            </div>
          </Button>
          <Button
            variant="outline"
            className="h-32 flex flex-col items-center justify-center gap-3 hover:border-primary hover:bg-primary/5"
            onClick={() => {
              onOpenChange(false);
              onChooseCyclus();
            }}
          >
            <Repeat className="h-8 w-8 text-primary" />
            <div className="text-center">
              <div className="font-medium">{t("calendar.cyclus", "Training Cycle")}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t("calendar.cyclusDesc", "Recurring sessions")}
              </div>
            </div>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
