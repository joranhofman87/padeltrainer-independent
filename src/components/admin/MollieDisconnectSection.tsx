import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Unplug } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from "@/lib/logger";

interface MollieAccount {
  id: string;
  mollie_organization_id: string;
  onboarding_complete: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}

interface MollieDisconnectSectionProps {
  entityId: string;
  entityType: "trainer" | "academy";
  entityName: string;
}

export function MollieDisconnectSection({
  entityId,
  entityType,
  entityName,
}: MollieDisconnectSectionProps) {
  const { toast } = useToast();
  const [mollieAccount, setMollieAccount] = useState<MollieAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchMollieAccount = async () => {
    if (entityType === "trainer") {
      return supabase
        .from("trainer_mollie_accounts")
        .select("id, mollie_organization_id, onboarding_complete, charges_enabled, payouts_enabled")
        .eq("trainer_id", entityId)
        .maybeSingle();
    }
    return supabase
      .from("academy_mollie_accounts")
      .select("id, mollie_organization_id, onboarding_complete, charges_enabled, payouts_enabled")
      .eq("academy_profile_id", entityId)
      .maybeSingle();
  };

  const deleteMollieAccount = async () => {
    if (entityType === "trainer") {
      const { error } = await supabase.from("trainer_mollie_accounts").delete().eq("trainer_id", entityId);
      if (error) throw error;
      const { error: e2 } = await supabase.from("trainer_profiles").update({ mollie_customer_id: null }).eq("id", entityId);
      if (e2) throw e2;
    } else {
      const { error } = await supabase.from("academy_mollie_accounts").delete().eq("academy_profile_id", entityId);
      if (error) throw error;
      const { error: e2 } = await supabase.from("academy_profiles").update({ mollie_customer_id: null }).eq("id", entityId);
      if (e2) throw e2;
    }
  };

  useEffect(() => {
    fetchMollieStatus();
  }, [entityId]);

  const fetchMollieStatus = async () => {
    setLoading(true);
    try {
      const { data, error } = await fetchMollieAccount();
      if (error) throw error;
      setMollieAccount(data);
    } catch (error) {
      logger.error("Error fetching Mollie status", error as Error, { component: "MollieDisconnectSection" });
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await deleteMollieAccount();

      setMollieAccount(null);
      toast({
        title: "Mollie disconnected",
        description: `Mollie connection removed for ${entityName}. They can now reconnect.`,
      });
    } catch (error) {
      logger.error("Error disconnecting Mollie", error as Error, { component: "MollieDisconnectSection" });
      toast({
        title: "Error",
        description: "Failed to disconnect Mollie. Please try again.",
        variant: "destructive",
      });
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading Mollie status...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-base font-medium">Mollie Connection</Label>
        <Badge variant={mollieAccount ? "default" : "outline"}>
          {mollieAccount ? "Connected" : "Not connected"}
        </Badge>
      </div>

      {mollieAccount ? (
        <>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Org ID: <code className="text-xs bg-muted px-1 py-0.5 rounded">{mollieAccount.mollie_organization_id}</code></p>
            <p>Onboarding: {mollieAccount.onboarding_complete ? "Complete" : "Incomplete"}</p>
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="w-full">
                <Unplug className="mr-2 h-4 w-4" />
                Disconnect Mollie
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Mollie?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the Mollie connection for <strong>{entityName}</strong>. 
                  Their access tokens and organization link will be deleted. 
                  They will need to reconnect Mollie from their earnings page.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {disconnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No Mollie account connected. The {entityType} can connect from their earnings page.
        </p>
      )}
    </div>
  );
}
