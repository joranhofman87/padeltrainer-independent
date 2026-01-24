import { useState } from "react";
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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface ClubSubscriptionData {
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
}

interface ClubSubscriptionEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clubId: string;
  clubName: string;
  currentData: ClubSubscriptionData;
  onSuccess: () => void;
}

const CLUB_STATUSES = ["trial", "active", "cancelled", "expired"];
const CLUB_TIERS = ["starter", "club"];

export function ClubSubscriptionEditDialog({
  open,
  onOpenChange,
  clubId,
  clubName,
  currentData,
  onSuccess,
}: ClubSubscriptionEditDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  const [status, setStatus] = useState(currentData.subscription_status || "trial");
  const [tier, setTier] = useState(currentData.subscription_tier || "starter");
  const [trialEndsAt, setTrialEndsAt] = useState<Date | undefined>(
    currentData.trial_ends_at ? new Date(currentData.trial_ends_at) : undefined
  );

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
        .from("club_profiles")
        .update({
          subscription_status: status,
          subscription_tier: tier,
          trial_ends_at: status === "active" ? null : (trialEndsAt?.toISOString() || null),
        })
        .eq("id", clubId);

      if (error) throw error;

      toast({
        title: "Subscription updated",
        description: `${clubName}'s subscription has been updated successfully.`,
      });

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error("Error updating subscription:", error);
      toast({
        title: "Error",
        description: "Failed to update subscription. Please try again.",
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
          <DialogTitle>Edit Club Subscription</DialogTitle>
          <DialogDescription>
            Manually update subscription for {clubName}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="status">Subscription Status</Label>
            <Select value={status} onValueChange={handleStatusChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {CLUB_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="tier">Subscription Tier</Label>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger>
                <SelectValue placeholder="Select tier" />
              </SelectTrigger>
              <SelectContent>
                {CLUB_TIERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
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
