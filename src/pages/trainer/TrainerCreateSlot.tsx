import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkCreateContent } from "@/components/slots/AddSlotDialog";
import { useAuth } from "@/hooks/useAuth";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function TrainerCreateSlot() {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [settings, setSettings] = useState({ slot_duration_minutes: 60, schedule_weeks_ahead: 4 });

  const dateParam = searchParams.get("date");
  const timeParam = searchParams.get("time");
  const cyclusParam = searchParams.get("cyclus");
  const defaultDate = dateParam ? new Date(dateParam) : undefined;
  const defaultTime = timeParam || undefined;

  useEffect(() => {
    if (!user) return;
    supabase
      .from("trainer_profiles")
      .select("id, slot_duration_minutes, schedule_weeks_ahead")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setTrainerId(data.id);
          setSettings({
            slot_duration_minutes: data.slot_duration_minutes || 60,
            schedule_weeks_ahead: data.schedule_weeks_ahead || 4,
          });
        }
      });
  }, [user]);

  return (
    <>
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            <h1 className="text-xl font-bold">{t("calendar.cyclusTitle", "Create Cycle")}</h1>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-6">
        <div className="max-w-lg">
          {trainerId && (
            <BulkCreateContent
              trainerId={trainerId}
              defaultDate={defaultDate}
              defaultTime={defaultTime}
              defaultDuration={settings.slot_duration_minutes}
              defaultWeeks={settings.schedule_weeks_ahead}
              onSlotsCreated={() => navigate("/app/trainer/calendar")}
              prefillFromCyclusId={cyclusParam}
            />
          )}
        </div>
      </main>
    </>
  );
}
