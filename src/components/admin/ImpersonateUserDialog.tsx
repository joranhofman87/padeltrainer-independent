import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, LogIn } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { logger } from '@/lib/logger';

interface ImpersonateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetUserId: string;
  targetUserName: string;
  targetUserEmail?: string | null;
}

export function ImpersonateUserDialog({
  open,
  onOpenChange,
  targetUserId,
  targetUserName,
  targetUserEmail,
}: ImpersonateUserDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  const handleImpersonate = async () => {
    setIsLoading(true);
    // Open tab synchronously to avoid popup blocker
    const newTab = window.open('about:blank', '_blank');
    try {
      const { data, error } = await supabase.functions.invoke("impersonate-user", {
        body: { target_user_id: targetUserId },
      });

      if (error) throw error;

      if (data?.url) {
        if (newTab) {
          newTab.location.href = data.url;
        } else {
          window.location.href = data.url;
        }
        toast({
          title: "Magic link generated",
          description: "Opening login link in a new tab...",
        });
        onOpenChange(false);
      } else {
        throw new Error("No magic link URL returned");
      }
    } catch (error) {
      newTab?.close();
      logger.error('Impersonation error', error as Error, { component: 'ImpersonateUserDialog', targetUserId });
      toast({
        title: "Impersonation failed",
        description: error instanceof Error ? error.message : "Failed to generate magic link",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <LogIn className="h-5 w-5" />
            Login as User
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <p>
              You are about to log in as <strong>{targetUserName}</strong>
              {targetUserEmail && (
                <span className="text-muted-foreground"> ({targetUserEmail})</span>
              )}
            </p>
            <p className="text-amber-600 dark:text-amber-400">
              This action is logged for security purposes. Use responsibly for support and debugging only.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleImpersonate} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating link...
              </>
            ) : (
              <>
                <LogIn className="mr-2 h-4 w-4" />
                Login as User
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
