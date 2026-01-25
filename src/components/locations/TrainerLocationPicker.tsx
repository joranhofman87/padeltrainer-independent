import { useState, useEffect, useMemo } from 'react';
import { Check, ChevronsUpDown, MapPin, X, Building2, User } from 'lucide-react';
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getActiveLocations, type Location, type TrainerRelationshipType } from '@/lib/locations';
import { useTranslation } from 'react-i18next';

export interface TrainerLocationSelection {
  locationId: string;
  isPrimary: boolean;
  relationshipType: TrainerRelationshipType;
}

interface TrainerLocationPickerProps {
  selectedLocations: TrainerLocationSelection[];
  onChange: (locations: TrainerLocationSelection[]) => void;
  maxSelections?: number;
  placeholder?: string;
  disabled?: boolean;
}

const COUNTRIES: Record<string, string> = {
  NL: 'Nederland',
};

export function TrainerLocationPicker({
  selectedLocations,
  onChange,
  maxSelections,
  placeholder,
  disabled = false,
}: TrainerLocationPickerProps) {
  const { t } = useTranslation('trainer');
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

  const selectedLocationIds = useMemo(() => 
    selectedLocations.map(s => s.locationId), 
    [selectedLocations]
  );

  const selectedLocationDetails = useMemo(() => {
    return selectedLocations.map(sel => ({
      ...sel,
      location: locations.find(l => l.id === sel.locationId),
    })).filter(s => s.location);
  }, [locations, selectedLocations]);

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

  const toggleLocation = (locationId: string) => {
    const existingIndex = selectedLocations.findIndex(s => s.locationId === locationId);
    
    if (existingIndex >= 0) {
      // Remove location
      const newLocations = selectedLocations.filter(s => s.locationId !== locationId);
      onChange(newLocations);
    } else {
      // Add location
      if (maxSelections && selectedLocations.length >= maxSelections) {
        return;
      }
      onChange([
        ...selectedLocations,
        {
          locationId,
          isPrimary: false,
          relationshipType: 'independent',
        },
      ]);
    }
  };


  const setRelationshipType = (locationId: string, type: TrainerRelationshipType) => {
    onChange(
      selectedLocations.map(s =>
        s.locationId === locationId ? { ...s, relationshipType: type } : s
      )
    );
  };

  const removeLocation = (locationId: string) => {
    const newLocations = selectedLocations.filter(s => s.locationId !== locationId);
    onChange(newLocations);
  };

  const clearAll = () => {
    onChange([]);
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
                ? t('locations.clubsSelected', '{{count}} clubs selected', { count: selectedLocations.length })
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
              onValueChange={setSearchValue}
            />
            <CommandList className="max-h-[300px]">
              <CommandEmpty>{t('locations.noResults', 'No locations found.')}</CommandEmpty>
              {groupedLocations.map(([city, cityLocations]) => (
                <CommandGroup key={city} heading={city}>
                  {cityLocations.map(location => {
                    const isSelected = selectedLocationIds.includes(location.id);
                    const selection = selectedLocations.find(s => s.locationId === location.id);
                    const canSelect = !maxSelections || selectedLocations.length < maxSelections || isSelected;

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
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Selected locations with relationship type */}
      {selectedLocationDetails.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {t('locations.selectedClubs', 'Selected clubs')}:
            </span>
            {selectedLocationDetails.length > 1 && (
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

          <div className="space-y-2">
            {selectedLocationDetails.map(({ locationId, isPrimary, relationshipType, location }) => (
              <div
                key={locationId}
                className="flex items-center gap-3 p-3 rounded-lg border"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{location?.name}</span>
                    <span className="text-xs text-muted-foreground">({location?.city})</span>
                  </div>
                </div>

                {/* Relationship type selector */}
                <TooltipProvider>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={relationshipType === 'independent' ? 'default' : 'outline'}
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setRelationshipType(locationId, 'independent')}
                        >
                          <User className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('locations.independent', 'Independent trainer')}</p>
                        <p className="text-xs text-muted-foreground">{t('locations.independentHint', 'You manage your own schedule')}</p>
                      </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={relationshipType === 'club_trainer' ? 'default' : 'outline'}
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setRelationshipType(locationId, 'club_trainer')}
                        >
                          <Building2 className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('locations.clubTrainer', 'Club trainer')}</p>
                        <p className="text-xs text-muted-foreground">{t('locations.clubTrainerHint', 'Club can manage your schedule')}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TooltipProvider>

                {/* Remove button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeLocation(locationId)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            <User className="h-3 w-3 inline mr-1" />
            {t('locations.independentLegend', 'Independent = You manage everything')}
            <span className="mx-2">|</span>
            <Building2 className="h-3 w-3 inline mr-1" />
            {t('locations.clubTrainerLegend', 'Club = Club can help manage')}
          </p>
        </div>
      )}
    </div>
  );
}
