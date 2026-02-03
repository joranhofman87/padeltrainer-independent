import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Building2, Check, X, Loader2, Mail, Phone, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/hooks/useAdminData";
import { verifyClubClaim, rejectClubClaim, ClubProfile } from "@/lib/club";
import { sendEmail } from "@/lib/email";
import { supabase } from "@/integrations/supabase/client";
import { logger } from '@/lib/logger';

interface PendingClaim extends ClubProfile {
  location: {
    id: string;
    name: string;
    city: string;
    street_address: string | null;
  };
  owner: {
    full_name: string | null;
    email: string | null;
  } | null;
}

async function fetchPendingClaims(): Promise<PendingClaim[]> {
  const { data: claims, error } = await supabase
    .from('club_profiles')
    .select(`
      *,
      location:locations(id, name, city, street_address)
    `)
    .eq('is_verified', false)
    .order('claimed_at', { ascending: false });

  if (error) {
    logger.warn('Error fetching pending claims', { error, component: 'AdminClubClaims' });
    return [];
  }

  if (!claims || claims.length === 0) {
    return [];
  }

  const clubIds = claims.map(c => c.id);
  const { data: managers } = await supabase
    .from('club_managers')
    .select('club_profile_id, user_id, role')
    .in('club_profile_id', clubIds)
    .eq('role', 'owner');

  const ownerUserIds = managers?.map(m => m.user_id).filter(Boolean) || [];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, full_name, email')
    .in('user_id', ownerUserIds);

  return claims.map((claim: any) => {
    const manager = managers?.find(m => m.club_profile_id === claim.id);
    const ownerProfile = profiles?.find(p => p.user_id === manager?.user_id);
    return {
      ...claim,
      owner: ownerProfile ? { full_name: ownerProfile.full_name, email: ownerProfile.email } : null,
    };
  });
}

export default function AdminClubClaims() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: isAdmin, isLoading: adminLoading } = useIsAdmin();

  const [processing, setProcessing] = useState<string | null>(null);

  const { data: claims = [], isLoading: claimsLoading } = useQuery({
    queryKey: ["admin", "pendingClaimsList"],
    queryFn: fetchPendingClaims,
    enabled: isAdmin === true,
    staleTime: 1000 * 60 * 2,
  });

  const loading = adminLoading || claimsLoading;

  const invalidateClaims = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "pendingClaimsList"] });
    queryClient.invalidateQueries({ queryKey: ["admin", "pendingClaims"] });
  };

  const handleVerify = async (claim: PendingClaim) => {
    setProcessing(claim.id);
    try {
      const success = await verifyClubClaim(claim.id);
      if (success) {
        if (claim.contact_email) {
          await sendEmail("club_claim_approved", claim.contact_email, {
            clubName: claim.location?.name || "Your Club",
            ownerName: claim.owner?.full_name || undefined,
          });
        }
        
        invalidateClaims();
        toast({
          title: "Club Verified",
          description: "The club claim has been approved and the owner has been notified.",
        });
      } else {
        toast({
          title: "Error",
          description: "Failed to verify club claim.",
          variant: "destructive",
        });
      }
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (claim: PendingClaim) => {
    setProcessing(claim.id);
    try {
      if (claim.contact_email) {
        await sendEmail("club_claim_rejected", claim.contact_email, {
          clubName: claim.location?.name || "the club",
          ownerName: claim.owner?.full_name || undefined,
        });
      }
      
      const success = await rejectClubClaim(claim.id);
      if (success) {
        invalidateClaims();
        toast({
          title: "Claim Rejected",
          description: "The club claim has been rejected and the user has been notified.",
        });
      } else {
        toast({
          title: "Error",
          description: "Failed to reject club claim.",
          variant: "destructive",
        });
      }
    } finally {
      setProcessing(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Pending Club Claims</h1>
        <p className="text-muted-foreground">
          Review and verify club ownership requests
        </p>
      </div>

      {claims.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Building2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <h3 className="text-lg font-semibold mb-1">No Pending Claims</h3>
            <p className="text-muted-foreground">
              All club claims have been processed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {claims.map((claim) => (
            <Card key={claim.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Building2 className="h-5 w-5" />
                      {claim.location?.name || "Unknown Location"}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-1 mt-1">
                      <MapPin className="h-3 w-3" />
                      {claim.location?.city}
                      {claim.location?.street_address && ` - ${claim.location.street_address}`}
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                    Pending Review
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Owner Info */}
                <div className="p-3 rounded-lg bg-muted/50">
                  <h4 className="text-sm font-medium mb-2">Claimed by</h4>
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">{claim.owner?.full_name || "Unknown"}</p>
                    <p className="text-muted-foreground flex items-center gap-1">
                      <Mail className="h-3 w-3" />
                      {claim.owner?.email || "No email"}
                    </p>
                  </div>
                </div>

                {/* Contact Info */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span>{claim.contact_email || "No contact email"}</span>
                  </div>
                  {claim.phone && (
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <span>{claim.phone}</span>
                    </div>
                  )}
                </div>

                {/* Description */}
                {claim.description && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">About the Club</h4>
                    <p className="text-sm text-muted-foreground">{claim.description}</p>
                  </div>
                )}

                {/* Claimed Date */}
                <p className="text-xs text-muted-foreground">
                  Claimed on {format(new Date(claim.claimed_at), "MMM d, yyyy 'at' HH:mm")}
                </p>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2 border-t">
                  <Button
                    onClick={() => handleVerify(claim)}
                    disabled={processing === claim.id}
                    className="flex-1"
                  >
                    {processing === claim.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        Approve
                      </>
                    )}
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        className="flex-1 text-destructive hover:text-destructive"
                        disabled={processing === claim.id}
                      >
                        <X className="h-4 w-4 mr-2" />
                        Reject
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reject Club Claim?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove this claim. The user will be notified
                          and will need to submit a new claim if they want to manage this club.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleReject(claim)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Reject Claim
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
