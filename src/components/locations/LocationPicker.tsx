import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { logger } from '@/lib/logger';
import { Check, ChevronsUpDown, MapPin, Star, X, Loader2 } from 'lucide-react';
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
import { getActiveLocations, searchLocations, type Location } from '@/lib/locations';
import { COUNTRIES } from '@/lib/countries';
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
  showCountryFilter?: boolean;
  serverSearch?: boolean;
}

// Use shared COUNTRIES from lib/countries.ts

export function LocationPicker({
  selectedLocationIds,
  onChange,
  primaryLocationId,
  onPrimaryChange,
  showPrimary = false,
  maxSelections,
  placeholder,
  disabled = false,
  showCountryFilter = true,
  serverSearch = false,
}: LocationPickerProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchValue, setSearchValue] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<string>('NL');
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function fetchLocations() {
      try {
        if (serverSearch) {
          // For server search mode, load initial 100 locations
          const data = await searchLocations('', 100);
          setLocations(data);
        } else {
          const data = await getActiveLocations();
          setLocations(data);
        }
      } catch (error) {
        logger.error('Error fetching locations', error instanceof Error ? error : new Error(String(error)), { component: 'LocationPicker' });
      } finally {
        setLoading(false);
      }
    }
    fetchLocations();
  }, [serverSearch]);

  // Debounced server-side search
  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
    
    if (!serverSearch) return;
    
    // Clear any pending timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    
    // Debounce the search
    searchTimeoutRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const data = await searchLocations(value, 100);
        setLocations(data);
      } catch (error) {
        console.error('Error searching locations:', error);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, [serverSearch]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Get unique countries from locations
  const availableCountries = useMemo(() => {
    const countries = new Set<string>();
    locations.forEach(l => {
      if (l.country) countries.add(l.country);
    });
    return Array.from(countries).sort();
  }, [locations]);

  const selectedLocations = useMemo(() => {
    return locations.filter(l => selectedLocationIds.includes(l.id));
  }, [locations, selectedLocationIds]);

  const groupedLocations = useMemo(() => {
    const filtered = locations.filter(l => {
      // Filter by country first
      if (selectedCountry && l.country !== selectedCountry) return false;
      // Then filter by search (client-side only if not using server search)
      if (searchValue && !serverSearch) {
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
  }, [locations, searchValue, selectedCountry, serverSearch]);

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

  const clearAll = () => {
    onChange([]);
    onPrimaryChange?.(undefined);
  };

  return (
    <div className="space-y-3">
      {/* Country filter */}
      {showCountryFilter && availableCountries.length > 0 && (
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
                ? t('locations.clubsSelected', { count: selectedLocations.length })
                : placeholder || t('locations.selectLocations', 'Select clubs...')}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t('locations.searchPlaceholder', 'Search by name or city...')}
              value={searchValue}
              onValueChange={handleSearchChange}
            />
            <CommandList className="max-h-[300px] relative">
              {searchLoading && (
                <div className="absolute inset-0 bg-background/80 flex items-center justify-center z-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
              <CommandEmpty>
                {searchLoading ? t('common.searching', 'Searching...') : t('locations.noResults', 'No locations found.')}
              </CommandEmpty>
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
                        className={cn(
                          !canSelect && 'opacity-50',
                          isSelected && 'bg-primary/10'
                        )}
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

      {/* Selected locations badges */}
      {selectedLocations.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t('locations.selectedClubs', 'Selected clubs')}:
            </span>
            {selectedLocations.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAll}
                className="h-auto py-1 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                {t('locations.clearAll', 'Clear all')}
              </Button>
            )}
          </div>
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
                      title={t('locations.setPreferred', 'Set as preferred')}
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
          {showPrimary && selectedLocations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('locations.preferredClubHint', '⭐ = Your preferred club')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
