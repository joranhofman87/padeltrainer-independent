import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MapPin, X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { supabase } from "@/lib/supabaseClient";

export interface SlotLocation {
  id: string;
  name: string;
  city: string;
  country?: string;
}

interface SlotLocationPickerProps {
  value: string | null;
  onChange: (locationId: string | null) => void;
  trainerId: string | null;
  disabled?: boolean;
  compact?: boolean;
  availableLocations?: SlotLocation[];
}

export function SlotLocationPicker({
  value,
  onChange,
  trainerId,
  disabled = false,
  compact = false,
  availableLocations,
}: SlotLocationPickerProps) {
  const { t } = useTranslation("trainer");
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<SlotLocation[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // If availableLocations are provided externally, use those instead of fetching
    if (availableLocations) {
      setLocations(availableLocations);
      if (!value && availableLocations.length === 1) {
        onChange(availableLocations[0].id);
      }
      return;
    }

    const fetchLocations = async () => {
      if (!trainerId) return;
      setLoading(true);
      try {
        const { data: trainerLocations, error } = await supabase
          .from("trainer_locations")
          .select(`
            id,
            is_primary,
            location_id,
            locations:location_id (
              id,
              name,
              city,
              country
            )
          `)
          .eq("trainer_id", trainerId);

        if (!error && trainerLocations) {
          const locs = trainerLocations
            .map((tl: any) => tl.locations)
            .filter(Boolean) as SlotLocation[];
          setLocations(locs);
          
          if (!value && locs.length === 1) {
            onChange(locs[0].id);
          }
        }
      } catch (e) {
        console.error("Error fetching trainer locations:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchLocations();
  }, [trainerId, availableLocations]);

  const selectedLocation = useMemo(() => {
    return locations.find((l) => l.id === value) || null;
  }, [locations, value]);

  const selectLocation = (locationId: string) => {
    onChange(locationId);
    setOpen(false);
  };

  const clearSelection = () => {
    onChange(null);
  };

  if (loading) {
    return (
      <Button variant="outline" disabled className={cn("w-full", compact && "h-8")}>
        <MapPin className="mr-2 h-4 w-4" />
        {t("calendar.loadingLocations", "Loading...")}
      </Button>
    );
  }

  if (locations.length === 0) {
    return (
      <Button variant="outline" disabled className={cn("w-full justify-start", compact && "h-8")}>
        <MapPin className="mr-2 h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          {t("calendar.noLocations", "No locations configured")}
        </span>
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "w-full justify-between",
              !selectedLocation && "text-muted-foreground",
              compact && "h-8"
            )}
          >
            <div className="flex items-center gap-2 truncate">
              <MapPin className="h-4 w-4 shrink-0" />
              {selectedLocation ? (
                <span className="truncate">
                  {selectedLocation.name}, {selectedLocation.city}
                </span>
              ) : (
                <span>{t("calendar.selectLocation", "Select location")}</span>
              )}
            </div>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command>
            <CommandInput placeholder={t("calendar.searchLocation", "Search location...")} />
            <CommandList>
              <CommandEmpty>{t("calendar.noLocationFound", "No location found")}</CommandEmpty>
              <CommandGroup>
                {locations.map((location) => (
                  <CommandItem
                    key={location.id}
                    value={`${location.name} ${location.city}`}
                    onSelect={() => selectLocation(location.id)}
                  >
                    <MapPin className="mr-2 h-4 w-4" />
                    <div className="flex flex-col">
                      <span>{location.name}</span>
                      <span className="text-xs text-muted-foreground">{location.city}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedLocation && !compact && (
        <Badge variant="secondary" className="gap-1">
          <MapPin className="h-3 w-3" />
          {selectedLocation.name}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-1 rounded-full hover:bg-muted-foreground/20"
            disabled={disabled}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      )}
    </div>
  );
}
