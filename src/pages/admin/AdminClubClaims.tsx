import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { ArrowLeft, Building2, Check, X, Loader2, Mail, Phone, MapPin } from "lucide-react";
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
import { useAuth } from "@/hooks/useAuth";
import { isUserAdmin } from "@/lib/admin";
import { getPendingClubClaims, verifyClubClaim, rejectClubClaim, ClubProfile } from "@/lib/club";
import { sendEmail } from "@/lib/email";

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

export default function AdminClubClaims() {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();

  const [claims, setClaims] = useState<PendingClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function checkAdminAndLoad() {
      if (!user) return;

      const adminStatus = await isUserAdmin(user.id);
      setIsAdmin(adminStatus);

      if (!adminStatus) {
        setLoading(false);
        return;
      }

      try {
        const pendingClaims = await getPendingClubClaims();
        setClaims(pendingClaims as PendingClaim[]);
      } finally {
        setLoading(false);
      }
    }
    checkAdminAndLoad();
  }, [user]);

  const handleVerify = async (claim: PendingClaim) => {
    setProcessing(claim.id);
    try {
      const success = await verifyClubClaim(claim.id);
      if (success) {
        // Send approval email
        if (claim.contact_email) {
          await sendEmail("club_claim_approved", claim.contact_email, {
            clubName: claim.location?.name || "Your Club",
            ownerName: claim.owner?.full_name || undefined,
          });
        }
        
        setClaims((prev) => prev.filter((c) => c.id !== claim.id));
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
      // Send rejection email before deleting
      if (claim.contact_email) {
        await sendEmail("club_claim_rejected", claim.contact_email, {
          clubName: claim.location?.name || "the club",
          ownerName: claim.owner?.full_name || undefined,
        });
      }
      
      const success = await rejectClubClaim(claim.id);
      if (success) {
        setClaims((prev) => prev.filter((c) => c.id !== claim.id));
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

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-8 w-64 mb-6" />
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
          <p className="text-muted-foreground mb-4">You don't have admin privileges.</p>
          <Button onClick={() => navigate("/")}>Go Home</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate("/admin")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Pending Club Claims</h1>
            <p className="text-sm text-muted-foreground">
              Review and verify club ownership requests
            </p>
          </div>
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
    </div>
  );
}
