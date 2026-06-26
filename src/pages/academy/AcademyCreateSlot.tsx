import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BulkCreateContent } from "@/components/trainer/AddSlotDialog";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { AcademyCreateSlotPrerequisites } from "@/components/academy/AcademyCreateSlotPrerequisites";
import { useEffect, useState } from "react";
import { getAcademyTrainersWithProfiles, getAcademyLocations } from "@/lib/academy";
import {
  hasBlockingAcademyCreateSlotPrerequisite,
  getAcademyCreateSlotPrerequisites,
  mapAcademyLocationsToSlotLocations,
} from "@/lib/academyCreateSlot";
import type { SlotLocation } from "@/components/slots/SlotLocationPicker";

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
  const [prerequisitesLoading, setPrerequisitesLoading] = useState(true);

  useEffect(() => {
    if (!activeAcademy) return;
    let cancelled = false;
    setPrerequisitesLoading(true);

    const load = async () => {
      try {
        const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
        const list = academyTrainers
          .filter((t: any) => t.status === "active" && t.trainer_profile)
          .map((t: any) => ({ id: t.trainer_profile.id, name: t.profile?.full_name || "Unknown" }));
        if (cancelled) return;
        setTrainers(list);
        if (!selectedTrainerId && list.length > 0) setSelectedTrainerId(list[0].id);

        const locs = await getAcademyLocations(activeAcademy.id);
        if (cancelled) return;
        setLocations(mapAcademyLocationsToSlotLocations(locs));
      } finally {
        if (!cancelled) setPrerequisitesLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAcademy?.id]);

  const prerequisites = getAcademyCreateSlotPrerequisites(trainers.length, locations.length);
  const blockedByTrainer = hasBlockingAcademyCreateSlotPrerequisite(prerequisites);

  return (
    <>
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label={t("common:goBack", "Go back")} onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            <h1 className="text-xl font-bold">{t("calendar.tabs.create", "Create Cycle")}</h1>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-6 max-w-6xl w-full">
        {prerequisitesLoading ? (
          <div className="mb-6 space-y-3" data-testid="academy-create-slot-loading">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </div>
        ) : (
          <AcademyCreateSlotPrerequisites
            activeTrainerCount={trainers.length}
            locationCount={locations.length}
          />
        )}
        {activeAcademy && !blockedByTrainer && (
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
      </main>
    </>
  );
}
