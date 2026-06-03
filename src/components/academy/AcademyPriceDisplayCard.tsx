import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Euro, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import {
  normalizePriceDisplayMode,
  type AcademyPriceDisplayMode,
} from "@/lib/academyPriceDisplay";

interface AcademyPriceDisplayCardProps {
  academyId: string;
}

export function AcademyPriceDisplayCard({ academyId }: AcademyPriceDisplayCardProps) {
  const { t } = useTranslation("academy");
  const { toast } = useToast();
  const { refreshAcademies } = useAcademyContext();
  const [mode, setMode] = useState<AcademyPriceDisplayMode>("including_vat");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("price_display_mode")
        .eq("id", academyId)
        .maybeSingle();

      if (!cancelled) {
        if (error) {
          setMode("including_vat");
        } else {
          setMode(normalizePriceDisplayMode(data?.price_display_mode));
        }
        setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [academyId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("academy_profiles")
        .update({ price_display_mode: mode })
        .eq("id", academyId);
      if (error) throw error;
      await refreshAcademies();
      toast({ title: t("settings.priceDisplay.saveSuccess") });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("settings.priceDisplay.saveError");
      toast({
        title: t("settings.priceDisplay.saveError"),
        description: message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card id="price-display">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Euro className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">{t("settings.priceDisplay.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.priceDisplay.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading", "Loading...")}
          </div>
        ) : (
          <>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(normalizePriceDisplayMode(v))}
              className="space-y-3"
            >
              <div className="flex items-start space-x-3">
                <RadioGroupItem value="including_vat" id="price-display-including" />
                <Label htmlFor="price-display-including" className="font-normal leading-snug cursor-pointer">
                  {t("settings.priceDisplay.includingVat")}
                </Label>
              </div>
              <div className="flex items-start space-x-3">
                <RadioGroupItem value="excluding_vat" id="price-display-excluding" />
                <Label htmlFor="price-display-excluding" className="font-normal leading-snug cursor-pointer">
                  {t("settings.priceDisplay.excludingVat")}
                </Label>
              </div>
            </RadioGroup>
            <p className="text-sm text-muted-foreground">{t("settings.priceDisplay.help")}</p>
            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t("common.save", "Save")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
