import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin } from "@/hooks/useAdminData";
import { useAllPricingPlans, useUpdatePricingPlan, useDeletePricingPlan, SubscriptionPlan } from "@/hooks/usePricingPlans";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, type ColumnDef } from "@/components/ui/data-table-generic";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Pencil, Trash2, Shield } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PlanEditDialog } from "@/components/admin/PlanEditDialog";
import { formatCurrency, formatCurrencyMaybe } from "@/lib/format";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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
    } catch {
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
    } catch {
      toast({
        title: t("common:toasts.errorTitle"),
        description: t("common:toasts.errorDescription"),
        variant: "destructive",
      });
    }
  };

  const trainerPlans = plans?.filter((p) => p.plan_type === "trainer") || [];
  const clubPlans = plans?.filter((p) => p.plan_type === "club") || [];

  // One shared column set for both the Trainer and Club plan tables (they are identical).
  const columns: ColumnDef<SubscriptionPlan>[] = [
    {
      key: "plan",
      header: "Plan",
      className: "max-w-[240px]",
      cellTitle: (plan) => plan.name,
      renderCell: (plan) => (
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{plan.name}</span>
          {plan.badge && (
            <Badge variant={plan.is_highlighted ? "default" : "secondary"} className="shrink-0">
              {plan.badge}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "monthly",
      header: t("pricing.monthly"),
      className: "whitespace-nowrap",
      renderCell: (plan) => formatCurrency(plan.monthly_price),
    },
    {
      key: "yearly",
      header: t("pricing.yearly"),
      className: "whitespace-nowrap",
      renderCell: (plan) => formatCurrency(plan.yearly_price),
    },
    {
      key: "platformFee",
      header: `${t("pricing.platformFee")} (€)`,
      className: "whitespace-nowrap",
      renderCell: (plan) => formatCurrencyMaybe(plan.platform_fee_flat),
    },
    {
      key: "active",
      header: t("pricing.active"),
      renderCell: (plan) => (
        <Switch
          checked={plan.is_active}
          onCheckedChange={() => handleToggleActive(plan)}
          disabled={updatePlan.isPending}
        />
      ),
    },
  ];

  const renderPlanActions = (plan: SubscriptionPlan) => (
    <>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit" onClick={() => setEditingPlan(plan)}>
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-destructive hover:text-destructive"
        aria-label="Delete"
        onClick={() => setDeletingPlan(plan)}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate("/admin")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-2xl font-bold">{t("pricing.title")}</h1>
          </div>
        </div>

        {/* Trainer Plans */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("pricing.trainerPlans")}</h2>
          <DataTable<SubscriptionPlan>
            columns={columns}
            rows={trainerPlans}
            renderActions={renderPlanActions}
            actionsHeader={t("pricing.actions")}
            compact
            desktopOnly={false}
            empty={t("common:noResults", "No results")}
          />
        </section>

        {/* Club Plans */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("pricing.clubPlans")}</h2>
          <DataTable<SubscriptionPlan>
            columns={columns}
            rows={clubPlans}
            renderActions={renderPlanActions}
            actionsHeader={t("pricing.actions")}
            compact
            desktopOnly={false}
            empty={t("common:noResults", "No results")}
          />
        </section>

        {/* Info Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-lg bg-primary/10">
                <Shield className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold mb-1">{t("pricing.mollieNoteTitle")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("pricing.mollieNote")}
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
      <ConfirmDialog
        open={!!deletingPlan}
        onOpenChange={(open) => !open && setDeletingPlan(null)}
        title={t("pricing.deletePlan")}
        description={t("pricing.deleteConfirm", { name: deletingPlan?.name })}
        confirmLabel={t("pricing.delete")}
        cancelLabel={t("pricing.cancel")}
        loading={deletePlan.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
