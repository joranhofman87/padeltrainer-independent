import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkCreateContent } from "@/components/trainer/AddSlotDialog";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { useEffect, useState } from "react";
import { getAcademyTrainersWithProfiles, getAcademyLocations } from "@/lib/academy";
import type { SlotLocation } from "@/components/trainer/SlotLocationPicker";

export default function AcademyCreateSlot() {
  const { t } = useTranslation("academy");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();

  const dateParam = searchParams.get("date");
  const timeParam = searchParams.get("time");
  const trainerParam = searchParams.get("trainer");
  const cyclusParam = searchParams.get("cyclus");
  const defaultDate = dateParam ? new Date(dateParam) : undefined;
  const defaultTime = timeParam || undefined;

  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [locations, setLocations] = useState<SlotLocation[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string | null>(trainerParam);

  useEffect(() => {
    if (!activeAcademy) return;
    const load = async () => {
      const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
      const list = academyTrainers
        .filter((t: any) => t.status === "active" && t.trainer_profile)
        .map((t: any) => ({ id: t.trainer_profile.id, name: t.profile?.full_name || "Unknown" }));
      setTrainers(list);
      if (!selectedTrainerId && list.length > 0) setSelectedTrainerId(list[0].id);

      const locs = await getAcademyLocations(activeAcademy.id);
      setLocations(locs.map((l: any) => ({ id: l.id, name: l.name, city: l.city, country: l.country })));
    };
    load();
  }, [activeAcademy]);

  return (
    <>
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            <h1 className="text-xl font-bold">{t("calendar.tabs.create", "Create Cycle")}</h1>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-6">
        <div className="max-w-lg">
          {activeAcademy && (
            <BulkCreateContent
              trainerId={selectedTrainerId}
              defaultDate={defaultDate}
              defaultTime={defaultTime}
              defaultDuration={60}
              defaultWeeks={8}
              onSlotsCreated={() => navigate("/app/academy/calendar")}
              availableLocations={locations}
              availableTrainers={trainers}
              academyId={activeAcademy.id}
              prefillFromCyclusId={cyclusParam}
            />
          )}
        </div>
      </main>
    </>
  );
}
