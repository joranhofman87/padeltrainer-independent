import { useState, useEffect, useMemo } from 'react';
import { Check, ChevronsUpDown, MapPin, Plus, X } from 'lucide-react';
import { logger } from '@/lib/logger';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { getActiveLocations, type Location } from '@/lib/locations';
import { useTranslation } from 'react-i18next';

interface LessonLocationPickerProps {
  value: string | null;
  onChange: (locationId: string | null, locationName: string | null) => void;
  onRequestNewClub: () => void;
  disabled?: boolean;
}

const COUNTRIES: Record<string, string> = {
  NL: 'Nederland',
};

export function LessonLocationPicker({
  value,
  onChange,
  onRequestNewClub,
  disabled = false,
}: LessonLocationPickerProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchValue, setSearchValue] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<string>('NL');

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

  const availableCountries = useMemo(() => {
    const countries = new Set<string>();
    locations.forEach(l => {
      if (l.country) countries.add(l.country);
    });
    return Array.from(countries).sort();
  }, [locations]);

  const selectedLocation = useMemo(() => {
    return locations.find(l => l.id === value);
  }, [locations, value]);

  const groupedLocations = useMemo(() => {
    const filtered = locations.filter(l => {
      if (selectedCountry && l.country !== selectedCountry) return false;
      if (searchValue) {
        return (
          l.name.toLowerCase().includes(searchValue.toLowerCase()) ||
          l.city.toLowerCase().includes(searchValue.toLowerCase())
        );
      }
      return true;
    });

    const groups: Record<string, Location[]> = {};
    filtered.forEach(location => {
      if (!groups[location.city]) {
        groups[location.city] = [];
      }
      groups[location.city].push(location);
    });

    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [locations, searchValue, selectedCountry]);

  const selectLocation = (location: Location) => {
    onChange(location.id, location.name);
    setOpen(false);
  };

  const clearSelection = () => {
    onChange(null, null);
  };

  return (
    <div className="space-y-3">
      {/* Country filter */}
      {availableCountries.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('locations.country', 'Country')}:</span>
          <Select value={selectedCountry} onValueChange={setSelectedCountry}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableCountries.map(country => (
                <SelectItem key={country} value={country}>
                  {COUNTRIES[country] || country}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className="flex-1 justify-between"
              disabled={disabled || loading}
            >
              <span className="flex items-center gap-2 truncate">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                {selectedLocation
                  ? `${selectedLocation.name} (${selectedLocation.city})`
                  : t('locations.selectClub', 'Select a club...')}
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
              <CommandList className="max-h-[300px]">
                <CommandEmpty>{t('locations.noResults', 'No clubs found.')}</CommandEmpty>
                {groupedLocations.map(([city, cityLocations]) => (
                  <CommandGroup key={city} heading={city}>
                    {cityLocations.map(location => {
                      const isSelected = value === location.id;

                      return (
                        <CommandItem
                          key={location.id}
                          value={`${location.name} ${location.city}`}
                          onSelect={() => selectLocation(location)}
                          className={cn(isSelected && 'bg-primary/10')}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-4 w-4',
                              isSelected ? 'opacity-100 text-primary' : 'opacity-0'
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
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onRequestNewClub}
          title={t('locations.requestNewClub', 'Request new club')}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Selected location badge */}
      {selectedLocation && (
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="flex items-center gap-1 pr-1">
            <MapPin className="h-3 w-3" />
            <span>{selectedLocation.name}</span>
            <span className="text-xs opacity-70">({selectedLocation.city})</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-4 w-4 p-0 hover:bg-transparent"
              onClick={clearSelection}
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        </div>
      )}
    </div>
  );
}
