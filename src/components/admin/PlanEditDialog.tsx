import { useState } from "react";
import { useUpdatePricingPlan, SubscriptionPlan } from "@/hooks/usePricingPlans";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, X } from "lucide-react";

interface PlanEditDialogProps {
  plan: SubscriptionPlan;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PlanEditDialog({ plan, open, onOpenChange }: PlanEditDialogProps) {
  const updatePlan = useUpdatePricingPlan();
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    name: plan.name,
    description: plan.description || "",
    monthly_price: plan.monthly_price,
    yearly_price: plan.yearly_price,
    platform_fee_flat: plan.platform_fee_flat ?? 1.00,
    max_lessons: plan.max_lessons,
    mollie_plan_id_monthly: plan.mollie_plan_id_monthly || "",
    mollie_plan_id_yearly: plan.mollie_plan_id_yearly || "",
    mollie_product_id_monthly: plan.mollie_product_id_monthly || "",
    mollie_product_id_yearly: plan.mollie_product_id_yearly || "",
    is_highlighted: plan.is_highlighted,
    badge: plan.badge || "",
    features: plan.features || [],
  });

  const [newFeature, setNewFeature] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updatePlan.mutateAsync({
        id: plan.id,
        ...formData,
        mollie_plan_id_monthly: formData.mollie_plan_id_monthly || null,
        mollie_plan_id_yearly: formData.mollie_plan_id_yearly || null,
        mollie_product_id_monthly: formData.mollie_product_id_monthly || null,
        mollie_product_id_yearly: formData.mollie_product_id_yearly || null,
        badge: formData.badge || null,
        description: formData.description || null,
      });
      toast({
        title: "Plan updated",
        description: `${formData.name} has been updated successfully.`,
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update plan.",
        variant: "destructive",
      });
    }
  };

  const addFeature = () => {
    if (newFeature.trim()) {
      setFormData((prev) => ({
        ...prev,
        features: [...prev.features, newFeature.trim()],
      }));
      setNewFeature("");
    }
  };

  const removeFeature = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      features: prev.features.filter((_, i) => i !== index),
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {plan.name} Plan</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <Tabs defaultValue="general" className="mt-4">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="pricing">Pricing</TabsTrigger>
              <TabsTrigger value="mollie">Mollie</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Plan Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="badge">Badge Text</Label>
                <Input
                  id="badge"
                  value={formData.badge}
                  onChange={(e) => setFormData((prev) => ({ ...prev, badge: e.target.value }))}
                  placeholder="e.g., Most Popular"
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="highlighted">Highlight Plan</Label>
                <Switch
                  id="highlighted"
                  checked={formData.is_highlighted}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({ ...prev, is_highlighted: checked }))
                  }
                />
              </div>

              <div className="space-y-2">
                <Label>Features</Label>
                <div className="space-y-2">
                  {formData.features.map((feature, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input value={feature} readOnly className="flex-1" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFeature(index)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Input
                      value={newFeature}
                      onChange={(e) => setNewFeature(e.target.value)}
                      placeholder="Add a feature..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addFeature();
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="icon" onClick={addFeature}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="pricing" className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="monthly_price">Monthly Price (€)</Label>
                  <Input
                    id="monthly_price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.monthly_price}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, monthly_price: parseFloat(e.target.value) || 0 }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="yearly_price">Yearly Price (€)</Label>
                  <Input
                    id="yearly_price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.yearly_price}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, yearly_price: parseFloat(e.target.value) || 0 }))
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="platform_fee_flat">Platform Fee (€)</Label>
                <Input
                  id="platform_fee_flat"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.platform_fee_flat}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      platform_fee_flat: parseFloat(e.target.value) || 0,
                    }))
                  }
                  placeholder="e.g. 1.00"
                />
                <p className="text-xs text-muted-foreground">
                  Flat fee deducted per booking (€1.00 Starter, €0.75 Professional, €0.50 Academy)
                </p>
              </div>

            </TabsContent>

            <TabsContent value="mollie" className="space-y-4 mt-4">
              <div className="p-4 bg-muted rounded-lg text-sm text-muted-foreground mb-4">
                <strong>Note:</strong> Mollie plan and product IDs are used for subscription management.
              </div>

              <div className="space-y-2">
                <Label htmlFor="mollie_plan_monthly">Mollie Plan ID (Monthly)</Label>
                <Input
                  id="mollie_plan_monthly"
                  value={formData.mollie_plan_id_monthly}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, mollie_plan_id_monthly: e.target.value }))
                  }
                  placeholder="plan_xxx"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="mollie_plan_yearly">Mollie Plan ID (Yearly)</Label>
                <Input
                  id="mollie_plan_yearly"
                  value={formData.mollie_plan_id_yearly}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, mollie_plan_id_yearly: e.target.value }))
                  }
                  placeholder="plan_xxx"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="mollie_product_monthly">Mollie Product ID (Monthly)</Label>
                <Input
                  id="mollie_product_monthly"
                  value={formData.mollie_product_id_monthly}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, mollie_product_id_monthly: e.target.value }))
                  }
                  placeholder="prod_xxx"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="mollie_product_yearly">Mollie Product ID (Yearly)</Label>
                <Input
                  id="mollie_product_yearly"
                  value={formData.mollie_product_id_yearly}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, mollie_product_id_yearly: e.target.value }))
                  }
                  placeholder="prod_xxx"
                />
              </div>
            </TabsContent>
          </Tabs>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={updatePlan.isPending}>
              {updatePlan.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
