import { useState, useEffect, useMemo } from 'react';
import { Check, ChevronsUpDown, MapPin, Star, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { getActiveLocations, type Location } from '@/lib/locations';
import { useTranslation } from 'react-i18next';

interface LocationPickerProps {
  selectedLocationIds: string[];
  onChange: (locationIds: string[]) => void;
  primaryLocationId?: string;
  onPrimaryChange?: (locationId: string | undefined) => void;
  showPrimary?: boolean;
  maxSelections?: number;
  placeholder?: string;
  disabled?: boolean;
}

export function LocationPicker({
  selectedLocationIds,
  onChange,
  primaryLocationId,
  onPrimaryChange,
  showPrimary = false,
  maxSelections,
  placeholder,
  disabled = false,
}: LocationPickerProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchValue, setSearchValue] = useState('');

  useEffect(() => {
    async function fetchLocations() {
      try {
        const data = await getActiveLocations();
        setLocations(data);
      } catch (error) {
        console.error('Error fetching locations:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchLocations();
  }, []);

  const selectedLocations = useMemo(() => {
    return locations.filter(l => selectedLocationIds.includes(l.id));
  }, [locations, selectedLocationIds]);

  const groupedLocations = useMemo(() => {
    const filtered = locations.filter(
      l =>
        l.name.toLowerCase().includes(searchValue.toLowerCase()) ||
        l.city.toLowerCase().includes(searchValue.toLowerCase())
    );

    const groups: Record<string, Location[]> = {};
    filtered.forEach(location => {
      if (!groups[location.city]) {
        groups[location.city] = [];
      }
      groups[location.city].push(location);
    });

    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [locations, searchValue]);

  const toggleLocation = (locationId: string) => {
    if (selectedLocationIds.includes(locationId)) {
      const newIds = selectedLocationIds.filter(id => id !== locationId);
      onChange(newIds);
      if (primaryLocationId === locationId) {
        onPrimaryChange?.(newIds[0] || undefined);
      }
    } else {
      if (maxSelections && selectedLocationIds.length >= maxSelections) {
        return;
      }
      const newIds = [...selectedLocationIds, locationId];
      onChange(newIds);
      if (!primaryLocationId && newIds.length === 1) {
        onPrimaryChange?.(locationId);
      }
    }
  };

  const setPrimary = (locationId: string) => {
    onPrimaryChange?.(locationId);
  };

  const removeLocation = (locationId: string) => {
    const newIds = selectedLocationIds.filter(id => id !== locationId);
    onChange(newIds);
    if (primaryLocationId === locationId) {
      onPrimaryChange?.(newIds[0] || undefined);
    }
  };

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={disabled || loading}
          >
            <span className="flex items-center gap-2 truncate">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              {selectedLocations.length > 0
                ? `${selectedLocations.length} ${selectedLocations.length === 1 ? 'location' : 'locations'} selected`
                : placeholder || t('locations.selectLocations', 'Select locations...')}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t('locations.searchPlaceholder', 'Search by name or city...')}
              value={searchValue}
              onValueChange={setSearchValue}
            />
            <CommandList>
              <CommandEmpty>{t('locations.noResults', 'No locations found.')}</CommandEmpty>
              {groupedLocations.map(([city, cityLocations]) => (
                <CommandGroup key={city} heading={city}>
                  {cityLocations.map(location => {
                    const isSelected = selectedLocationIds.includes(location.id);
                    const isPrimary = primaryLocationId === location.id;
                    const canSelect = !maxSelections || selectedLocationIds.length < maxSelections || isSelected;

                    return (
                      <CommandItem
                        key={location.id}
                        value={`${location.name} ${location.city}`}
                        onSelect={() => canSelect && toggleLocation(location.id)}
                        className={cn(!canSelect && 'opacity-50')}
                      >
                        <Check
                          className={cn(
                            'mr-2 h-4 w-4',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <div className="flex-1">
                          <span className="font-medium">{location.name}</span>
                          {location.street_address && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {location.street_address}
                            </span>
                          )}
                        </div>
                        {isPrimary && showPrimary && (
                          <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedLocations.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedLocations.map(location => {
            const isPrimary = primaryLocationId === location.id;
            return (
              <Badge
                key={location.id}
                variant={isPrimary ? 'default' : 'secondary'}
                className="flex items-center gap-1 pr-1"
              >
                {isPrimary && showPrimary && (
                  <Star className="h-3 w-3 fill-current" />
                )}
                <span>{location.name}</span>
                <span className="text-xs opacity-70">({location.city})</span>
                {showPrimary && !isPrimary && selectedLocations.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-4 w-4 p-0 hover:bg-transparent"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPrimary(location.id);
                    }}
                  >
                    <Star className="h-3 w-3" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-4 w-4 p-0 hover:bg-transparent"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeLocation(location.id);
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
