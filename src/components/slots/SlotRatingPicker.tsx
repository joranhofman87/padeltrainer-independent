import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getRatingSystems, type RatingSystemConfig } from "@/lib/ratingSystems";

interface SlotRatingPickerProps {
  ratingSystem: string | null;
  minRating: number | null;
  maxRating: number | null;
  onChange: (values: { ratingSystem: string | null; minRating: number | null; maxRating: number | null }) => void;
  compact?: boolean;
  /** When set, locks to this rating system and hides the system dropdown */
  fixedRatingSystem?: string | null;
}

export function SlotRatingPicker({
  ratingSystem,
  minRating,
  maxRating,
  onChange,
  compact = false,
  fixedRatingSystem,
}: SlotRatingPickerProps) {
  const { t } = useTranslation("trainer");
  const [systems, setSystems] = useState<RatingSystemConfig[]>([]);

  useEffect(() => {
    getRatingSystems().then(setSystems);
  }, []);

  // If fixed system is set, use it as the active system
  const effectiveSystem = fixedRatingSystem || ratingSystem;
  const selectedSystem = systems.find((s) => s.code === effectiveSystem) || null;

  // When fixed system is set and differs from current, sync it
  useEffect(() => {
    if (fixedRatingSystem && ratingSystem !== fixedRatingSystem) {
      onChange({ ratingSystem: fixedRatingSystem, minRating, maxRating });
    }
  }, [fixedRatingSystem]);

  const handleSystemChange = (value: string) => {
    if (value === "none") {
      onChange({ ratingSystem: null, minRating: null, maxRating: null });
    } else {
      onChange({ ratingSystem: value, minRating, maxRating });
    }
  };

  const handleMinChange = (value: string) => {
    const num = value === "" ? null : parseFloat(value);
    onChange({ ratingSystem: effectiveSystem, minRating: num, maxRating });
  };

  const handleMaxChange = (value: string) => {
    const num = value === "" ? null : parseFloat(value);
    onChange({ ratingSystem: effectiveSystem, minRating, maxRating: num });
  };

  const labelClass = compact ? "text-xs" : undefined;
  const inputClass = compact ? "h-8" : undefined;

  return (
    <div className="space-y-2">
      {/* Only show system dropdown if no fixed system */}
      {!fixedRatingSystem && (
        <div className="space-y-1">
          <Label className={labelClass}>{t("calendar.ratingSystem", "Rating System")}</Label>
          <Select value={ratingSystem || "none"} onValueChange={handleSystemChange}>
            <SelectTrigger className={inputClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("calendar.anyLevel", "Any level")}</SelectItem>
              {systems.map((s) => (
                <SelectItem key={s.code} value={s.code}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Show fixed system label when locked */}
      {fixedRatingSystem && selectedSystem && (
        <div className="space-y-1">
          <Label className={labelClass}>{t("calendar.ratingSystem", "Rating System")}</Label>
          <p className="text-sm text-muted-foreground">{selectedSystem.name}</p>
        </div>
      )}

      {selectedSystem && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className={labelClass}>{t("calendar.minRating", "Min Rating")}</Label>
            <Input
              type="number"
              value={minRating ?? ""}
              onChange={(e) => handleMinChange(e.target.value)}
              placeholder={String(selectedSystem.min_rating)}
              min={selectedSystem.min_rating}
              max={selectedSystem.max_rating}
              step={selectedSystem.step}
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <Label className={labelClass}>{t("calendar.maxRating", "Max Rating")}</Label>
            <Input
              type="number"
              value={maxRating ?? ""}
              onChange={(e) => handleMaxChange(e.target.value)}
              placeholder={String(selectedSystem.max_rating)}
              min={selectedSystem.min_rating}
              max={selectedSystem.max_rating}
              step={selectedSystem.step}
              className={inputClass}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Format a slot's rating range for display as a compact string */
export function formatSlotRating(
  ratingSystem: string | null | undefined,
  minRating: number | null | undefined,
  maxRating: number | null | undefined,
): string | null {
  if (!ratingSystem) return null;
  const sysName = ratingSystem.toUpperCase();
  if (minRating != null && maxRating != null) {
    return `${sysName} ${minRating}–${maxRating}`;
  }
  if (minRating != null) return `${sysName} ≥${minRating}`;
  if (maxRating != null) return `${sysName} ≤${maxRating}`;
  return sysName;
}
