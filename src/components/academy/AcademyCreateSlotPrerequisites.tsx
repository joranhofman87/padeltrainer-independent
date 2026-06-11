import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { UserPlus, MapPin } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  getAcademyCreateSlotPrerequisites,
  type AcademyCreateSlotPrerequisite,
} from "@/lib/academyCreateSlot";

interface AcademyCreateSlotPrerequisitesProps {
  activeTrainerCount: number;
  locationCount: number;
}

function PrerequisiteCard({
  prerequisite,
}: {
  prerequisite: AcademyCreateSlotPrerequisite;
}) {
  const { t } = useTranslation("academy");

  if (prerequisite.kind === "trainer") {
    return (
      <Alert variant="destructive">
        <UserPlus className="h-4 w-4" />
        <AlertTitle>{t("createSlot.noTrainerTitle")}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{t("createSlot.noTrainerDescription")}</p>
          <Button variant="outline" size="sm" asChild aria-label={t("createSlot.addTrainerCta")}>
            <Link to="/app/academy/trainers">{t("createSlot.addTrainerCta")}</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert>
      <MapPin className="h-4 w-4" />
      <AlertTitle>{t("createSlot.noLocationTitle")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t("createSlot.noLocationDescription")}</p>
        <Button variant="outline" size="sm" asChild aria-label={t("createSlot.addLocationCta")}>
          <Link to="/app/academy/locations">{t("createSlot.addLocationCta")}</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function AcademyCreateSlotPrerequisites({
  activeTrainerCount,
  locationCount,
}: AcademyCreateSlotPrerequisitesProps) {
  const prerequisites = getAcademyCreateSlotPrerequisites(activeTrainerCount, locationCount);

  if (prerequisites.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3 mb-6">
      {prerequisites.map((prerequisite) => (
        <PrerequisiteCard key={prerequisite.kind} prerequisite={prerequisite} />
      ))}
    </div>
  );
}
