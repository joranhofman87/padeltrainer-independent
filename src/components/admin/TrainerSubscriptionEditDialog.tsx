import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";

interface TrainerSubscriptionData {
  subscription_status: string | null;
  trial_ends_at: string | null;
  is_public: boolean;
}

interface TrainerSubscriptionEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainerId: string;
  trainerName: string;
  currentData: TrainerSubscriptionData;
  onSuccess: () => void;
}

const TRAINER_STATUSES = ["trial", "active", "cancelled", "expired"];

export function TrainerSubscriptionEditDialog({
  open,
  onOpenChange,
  trainerId,
  trainerName,
  currentData,
  onSuccess,
}: TrainerSubscriptionEditDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  const [status, setStatus] = useState(currentData.subscription_status || "trial");
  const [trialEndsAt, setTrialEndsAt] = useState<Date | undefined>(
    currentData.trial_ends_at ? new Date(currentData.trial_ends_at) : undefined
  );
  const [isPublic, setIsPublic] = useState(currentData.is_public);

  // Reset state when currentData changes (different trainer selected)
  useEffect(() => {
    setStatus(currentData.subscription_status || "trial");
    setTrialEndsAt(currentData.trial_ends_at ? new Date(currentData.trial_ends_at) : undefined);
    setIsPublic(currentData.is_public);
  }, [currentData, trainerId]);

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    if (newStatus === "active") {
      setTrialEndsAt(undefined);
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("trainer_profiles")
        .update({
          subscription_status: status,
          trial_ends_at: status === "active" ? null : (trialEndsAt?.toISOString() || null),
          is_public: isPublic,
        })
        .eq("id", trainerId);

      if (error) throw error;

      toast({
        title: "Trainer updated",
        description: `${trainerName}'s profile has been updated successfully.`,
      });

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error("Error updating trainer:", error);
      toast({
        title: "Error",
        description: "Failed to update trainer. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Trainer</DialogTitle>
          <DialogDescription>
            Update settings for {trainerName}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="is-public">Profile Visibility</Label>
              <p className="text-sm text-muted-foreground">
                Allow trainer to appear in public listings
              </p>
            </div>
            <Switch
              id="is-public"
              checked={isPublic}
              onCheckedChange={setIsPublic}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="status">Subscription Status</Label>
            <Select value={status} onValueChange={handleStatusChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {TRAINER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {status !== "active" && (
            <div className="grid gap-2">
              <Label>Trial Ends At</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "justify-start text-left font-normal",
                      !trialEndsAt && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {trialEndsAt ? format(trialEndsAt, "PPP") : "Select date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={trialEndsAt}
                    onSelect={setTrialEndsAt}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
