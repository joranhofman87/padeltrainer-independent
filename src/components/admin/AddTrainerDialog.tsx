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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Copy, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface AddTrainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function AddTrainerDialog({
  open,
  onOpenChange,
  onSuccess,
}: AddTrainerDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form state
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>("trial");
  const [isPublic, setIsPublic] = useState(false);

  // Result state
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [isNewUser, setIsNewUser] = useState(false);

  const resetForm = () => {
    setFullName("");
    setEmail("");
    setPhone("");
    setSubscriptionStatus("trial");
    setIsPublic(false);
    setCreatedPassword(null);
    setIsNewUser(false);
    setCopied(false);
  };

  const handleCopyPassword = async () => {
    if (createdPassword) {
      await navigator.clipboard.writeText(createdPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSave = async () => {
    if (!fullName.trim()) {
      toast({
        title: "Name required",
        description: "Please enter the trainer's full name.",
        variant: "destructive",
      });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    
    if (!trimmedEmail) {
      toast({
        title: "Email required",
        description: "Please enter the trainer's email address.",
        variant: "destructive",
      });
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address (e.g., name@example.com).",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-admin-trainer", {
        body: {
          email: trimmedEmail,
          fullName: fullName.trim(),
          phone: phone.trim() || null,
          subscriptionStatus,
          isPublic,
        },
      });

      if (error) throw error;

      if (data?.error) {
        throw new Error(data.error);
      }

      if (data.isNewUser && data.temporaryPassword) {
        // Show password to admin
        setCreatedPassword(data.temporaryPassword);
        setIsNewUser(true);
        toast({
          title: "Trainer created",
          description: "A new account has been created. Please copy the temporary password.",
        });
      } else {
        toast({
          title: "Trainer profile created",
          description: `${fullName} now has a trainer profile (existing account).`,
        });
        resetForm();
        onSuccess();
        onOpenChange(false);
      }
    } catch (error) {
      console.error("Error creating trainer:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create trainer. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    resetForm();
    if (createdPassword) {
      onSuccess();
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => {
      if (!open) handleClose();
      else onOpenChange(open);
    }}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Add Trainer</DialogTitle>
          <DialogDescription>
            Create a new trainer account with login credentials.
          </DialogDescription>
        </DialogHeader>

        {createdPassword ? (
          // Success view with password
          <div className="py-4 space-y-4">
            <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Account created for {fullName}</p>
                <p className="text-sm text-muted-foreground">{email}</p>
              </div>
              
              <div className="space-y-2">
                <Label className="text-sm">Temporary Password</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-background px-3 py-2 font-mono text-sm border">
                    {createdPassword}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPassword}
                    className="shrink-0"
                  >
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
            
            <p className="text-sm text-muted-foreground">
              Share this password securely with the trainer. They can change it after logging in.
            </p>
          </div>
        ) : (
          // Form view
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="fullName">Full Name *</Label>
              <Input
                id="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Jan de Vries"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="trainer@example.com"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+31 6 12345678"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="subscriptionStatus">Subscription Status</Label>
              <Select value={subscriptionStatus} onValueChange={setSubscriptionStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Trial (7 days)</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between pt-2">
              <div className="space-y-0.5">
                <Label htmlFor="isPublic">Public Profile</Label>
                <p className="text-xs text-muted-foreground">
                  Visible in the trainer directory
                </p>
              </div>
              <Switch
                id="isPublic"
                checked={isPublic}
                onCheckedChange={setIsPublic}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {createdPassword ? (
            <Button onClick={handleClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Trainer"
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
