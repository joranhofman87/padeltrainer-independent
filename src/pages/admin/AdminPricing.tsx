import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useAdminData";
import { useAllPricingPlans, useUpdatePricingPlan, useDeletePricingPlan, SubscriptionPlan } from "@/hooks/usePricingPlans";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Pencil, Trash2, Shield, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PlanEditDialog } from "@/components/admin/PlanEditDialog";
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

export default function AdminPricing() {
  const navigate = useNavigate();
  const { t } = useTranslation("admin");
  const { user, loading: authLoading } = useAuth();
  const { data: isAdmin, isLoading: adminLoading } = useIsAdmin();
  const { data: plans, isLoading: plansLoading } = useAllPricingPlans();
  const updatePlan = useUpdatePricingPlan();
  const deletePlan = useDeletePricingPlan();
  const { toast } = useToast();

  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<SubscriptionPlan | null>(null);

  const loading = authLoading || adminLoading || plansLoading;

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!user || !isAdmin) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Shield className="h-16 w-16 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">{t("accessDenied")}</h2>
            <p className="text-muted-foreground text-center mb-4">
              {t("noPermission")}
            </p>
            <Button onClick={() => navigate("/")}>{t("goHome")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleToggleActive = async (plan: SubscriptionPlan) => {
    try {
      await updatePlan.mutateAsync({ id: plan.id, is_active: !plan.is_active });
      toast({
        title: t("pricing.planUpdated"),
        description: t("pricing.planNowStatus", { 
          name: plan.name, 
          status: !plan.is_active ? t("pricing.active").toLowerCase() : t("pricing.inactive").toLowerCase() 
        }),
      });
    } catch (error) {
      toast({
        title: t("common:toasts.errorTitle"),
        description: t("common:toasts.errorDescription"),
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!deletingPlan) return;
    try {
      await deletePlan.mutateAsync(deletingPlan.id);
      toast({
        title: t("pricing.planDeleted"),
        description: t("pricing.planDeletedDesc", { name: deletingPlan.name }),
      });
      setDeletingPlan(null);
    } catch (error) {
      toast({
        title: t("common:toasts.errorTitle"),
        description: t("common:toasts.errorDescription"),
        variant: "destructive",
      });
    }
  };

  const trainerPlans = plans?.filter((p) => p.plan_type === "trainer") || [];
  const clubPlans = plans?.filter((p) => p.plan_type === "club") || [];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/admin")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-2xl font-bold">{t("pricing.title")}</h1>
          </div>
        </div>

        {/* Trainer Plans */}
        <Card>
          <CardHeader>
            <CardTitle>{t("pricing.trainerPlans")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>{t("pricing.monthly")}</TableHead>
                  <TableHead>{t("pricing.yearly")}</TableHead>
                  <TableHead>{t("pricing.platformFee")}</TableHead>
                  <TableHead>{t("pricing.maxLessons")}</TableHead>
                  <TableHead>{t("pricing.active")}</TableHead>
                  <TableHead className="text-right">{t("pricing.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trainerPlans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{plan.name}</span>
                        {plan.badge && (
                          <Badge variant={plan.is_highlighted ? "default" : "secondary"}>
                            {plan.badge}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>€{plan.monthly_price}</TableCell>
                    <TableCell>€{plan.yearly_price}</TableCell>
                    <TableCell>{plan.platform_fee_percent}%</TableCell>
                    <TableCell>{plan.max_lessons ?? "∞"}</TableCell>
                    <TableCell>
                      <Switch
                        checked={plan.is_active}
                        onCheckedChange={() => handleToggleActive(plan)}
                        disabled={updatePlan.isPending}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingPlan(plan)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingPlan(plan)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Club Plans */}
        <Card>
          <CardHeader>
            <CardTitle>{t("pricing.clubPlans")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>{t("pricing.monthly")}</TableHead>
                  <TableHead>{t("pricing.yearly")}</TableHead>
                  <TableHead>{t("pricing.platformFee")}</TableHead>
                  <TableHead>{t("pricing.active")}</TableHead>
                  <TableHead className="text-right">{t("pricing.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clubPlans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{plan.name}</span>
                        {plan.badge && (
                          <Badge variant={plan.is_highlighted ? "default" : "secondary"}>
                            {plan.badge}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>€{plan.monthly_price}</TableCell>
                    <TableCell>€{plan.yearly_price}</TableCell>
                    <TableCell>{plan.platform_fee_percent}%</TableCell>
                    <TableCell>
                      <Switch
                        checked={plan.is_active}
                        onCheckedChange={() => handleToggleActive(plan)}
                        disabled={updatePlan.isPending}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setEditingPlan(plan)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingPlan(plan)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Info Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-primary/10">
                <Shield className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">{t("pricing.stripeNoteTitle")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("pricing.stripeNote")}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Edit Dialog */}
      {editingPlan && (
        <PlanEditDialog
          plan={editingPlan}
          open={!!editingPlan}
          onOpenChange={(open) => !open && setEditingPlan(null)}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingPlan} onOpenChange={(open) => !open && setDeletingPlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pricing.deletePlan")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pricing.deleteConfirm", { name: deletingPlan?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("pricing.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePlan.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("pricing.delete")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
