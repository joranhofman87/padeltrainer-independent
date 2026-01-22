import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { SlidersHorizontal, X, Star, MapPin, Check, ChevronsUpDown, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { Location } from '@/lib/locations';
import { cn } from '@/lib/utils';

export interface TrainerFiltersState {
  priceRange: [number, number];
  minRating: number;
  specializations: string[];
  certifications: string[];
  minExperience: number;
  locationId: string;
  verifiedOnly: boolean;
  minKnltbRating: number;
}

interface TrainerFiltersProps {
  filters: TrainerFiltersState;
  onChange: (filters: TrainerFiltersState) => void;
  locations: Location[];
  allSpecializations: string[];
  allCertifications: string[];
  activeFilterCount: number;
}

const DEFAULT_FILTERS: TrainerFiltersState = {
  priceRange: [0, 200],
  minRating: 0,
  specializations: [],
  certifications: [],
  minExperience: 0,
  locationId: 'all',
  verifiedOnly: false,
  minKnltbRating: 0,
};

export function TrainerFilters({
  filters,
  onChange,
  locations,
  allSpecializations,
  allCertifications,
  activeFilterCount,
}: TrainerFiltersProps) {
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [isExpanded, setIsExpanded] = useState(true);

  const handleReset = () => {
    onChange(DEFAULT_FILTERS);
  };

  const toggleSpecialization = (spec: string) => {
    onChange({
      ...filters,
      specializations: filters.specializations.includes(spec)
        ? filters.specializations.filter(s => s !== spec)
        : [...filters.specializations, spec],
    });
  };

  const toggleCertification = (cert: string) => {
    onChange({
      ...filters,
      certifications: filters.certifications.includes(cert)
        ? filters.certifications.filter(c => c !== cert)
        : [...filters.certifications, cert],
    });
  };

  // Get unique countries
  const availableCountries = useMemo(() => {
    const countries = [...new Set(locations.map(l => l.country))].sort();
    return countries;
  }, [locations]);

  // Get selected location details
  const selectedLocation = useMemo(() => {
    if (filters.locationId === 'all') return null;
    return locations.find(l => l.id === filters.locationId);
  }, [filters.locationId, locations]);

  // Filter and group locations
  const groupedLocations = useMemo(() => {
    const filtered = locations.filter(loc => {
      const matchesCountry = selectedCountry === 'all' || loc.country === selectedCountry;
      const matchesSearch = !locationSearch || 
        loc.name.toLowerCase().includes(locationSearch.toLowerCase()) ||
        loc.city.toLowerCase().includes(locationSearch.toLowerCase());
      return matchesCountry && matchesSearch;
    });

    // Group by city
    const grouped = filtered.reduce((acc, loc) => {
      if (!acc[loc.city]) acc[loc.city] = [];
      acc[loc.city].push(loc);
      return acc;
    }, {} as Record<string, Location[]>);

    return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
  }, [locations, selectedCountry, locationSearch]);

  const selectLocation = (locationId: string) => {
    onChange({ ...filters, locationId });
    setLocationOpen(false);
    setLocationSearch('');
  };

  return (
    <Card className="w-full">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              <CardTitle className="text-base">Filters</CardTitle>
              {activeFilterCount > 0 && (
                <Badge variant="secondary" className="h-5 w-5 p-0 flex items-center justify-center text-xs">
                  {activeFilterCount}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              {activeFilterCount > 0 && (
                <Button variant="ghost" size="sm" onClick={handleReset} className="h-8 text-xs gap-1">
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </Button>
              )}
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 lg:hidden">
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        </CardHeader>
        
        <CollapsibleContent>
          <CardContent className="space-y-5 pt-0">
            {/* Location - Club Picker */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Club Location</Label>
              
              {/* Country filter */}
              {availableCountries.length > 1 && (
                <Select value={selectedCountry} onValueChange={setSelectedCountry}>
                  <SelectTrigger className="w-full h-9 text-sm">
                    <SelectValue placeholder="All Countries" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Countries</SelectItem>
                    {availableCountries.map(country => (
                      <SelectItem key={country} value={country}>{country}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Club picker */}
              <Popover open={locationOpen} onOpenChange={setLocationOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={locationOpen}
                    className="w-full justify-between h-9 text-sm"
                  >
                    {selectedLocation ? (
                      <span className="flex items-center gap-2 truncate">
                        <MapPin className="h-3 w-3 shrink-0" />
                        <span className="truncate">{selectedLocation.name}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Select a club...</span>
                    )}
                    <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput 
                      placeholder="Search clubs..." 
                      value={locationSearch}
                      onValueChange={setLocationSearch}
                    />
                    <CommandList className="max-h-[250px]">
                      <CommandEmpty>No clubs found.</CommandEmpty>
                      <CommandItem
                        value="all"
                        onSelect={() => selectLocation('all')}
                        className="font-medium"
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            filters.locationId === 'all' ? "opacity-100" : "opacity-0"
                          )}
                        />
                        All Locations
                      </CommandItem>
                      {groupedLocations.map(([city, locs]) => (
                        <CommandGroup key={city} heading={city}>
                          {locs.map(loc => (
                            <CommandItem
                              key={loc.id}
                              value={loc.id}
                              onSelect={() => selectLocation(loc.id)}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  filters.locationId === loc.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <span className="truncate">{loc.name}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedLocation && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs p-0"
                  onClick={() => onChange({ ...filters, locationId: 'all' })}
                >
                  <X className="h-3 w-3 mr-1" /> Clear location
                </Button>
              )}
            </div>

            {/* Price Range */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Price Range</Label>
                <span className="text-xs text-muted-foreground">
                  €{filters.priceRange[0]} - €{filters.priceRange[1]}
                </span>
              </div>
              <Slider
                value={filters.priceRange}
                onValueChange={(value) => onChange({ ...filters, priceRange: value as [number, number] })}
                min={0}
                max={200}
                step={5}
                className="w-full"
              />
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    type="number"
                    value={filters.priceRange[0]}
                    onChange={(e) => onChange({
                      ...filters,
                      priceRange: [Number(e.target.value), filters.priceRange[1]]
                    })}
                    className="h-8 text-sm"
                    placeholder="Min"
                  />
                </div>
                <div className="flex-1">
                  <Input
                    type="number"
                    value={filters.priceRange[1]}
                    onChange={(e) => onChange({
                      ...filters,
                      priceRange: [filters.priceRange[0], Number(e.target.value)]
                    })}
                    className="h-8 text-sm"
                    placeholder="Max"
                  />
                </div>
              </div>
            </div>

            {/* Minimum Rating */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Min Rating</Label>
              <div className="flex gap-1 flex-wrap">
                {[0, 3, 4, 4.5].map((rating) => (
                  <Button
                    key={rating}
                    variant={filters.minRating === rating ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => onChange({ ...filters, minRating: rating })}
                  >
                    {rating === 0 ? 'Any' : (
                      <span className="flex items-center gap-0.5">
                        {rating}+ <Star className="h-3 w-3 fill-current" />
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            </div>

            {/* Minimum KNLTB Rating */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Trainer KNLTB</Label>
              <div className="flex gap-1 flex-wrap">
                {[0, 4, 5, 6, 7, 8].map((rating) => (
                  <Button
                    key={rating}
                    variant={filters.minKnltbRating === rating ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => onChange({ ...filters, minKnltbRating: rating })}
                  >
                    {rating === 0 ? 'Any' : `${rating}+`}
                  </Button>
                ))}
              </div>
            </div>

            {/* Minimum Experience */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Experience</Label>
              <div className="flex gap-1 flex-wrap">
                {[0, 1, 3, 5, 10].map((years) => (
                  <Button
                    key={years}
                    variant={filters.minExperience === years ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => onChange({ ...filters, minExperience: years })}
                  >
                    {years === 0 ? 'Any' : `${years}+ yr`}
                  </Button>
                ))}
              </div>
            </div>

            {/* Specializations */}
            {allSpecializations.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Specializations</Label>
                <div className="flex flex-wrap gap-1.5">
                  {allSpecializations.map((spec) => (
                    <Badge
                      key={spec}
                      variant={filters.specializations.includes(spec) ? 'default' : 'outline'}
                      className="cursor-pointer hover:bg-primary/80 text-xs"
                      onClick={() => toggleSpecialization(spec)}
                    >
                      {spec}
                      {filters.specializations.includes(spec) && (
                        <X className="h-3 w-3 ml-1" />
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Certifications */}
            {allCertifications.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Certifications</Label>
                <div className="flex flex-wrap gap-1.5">
                  {allCertifications.map((cert) => (
                    <Badge
                      key={cert}
                      variant={filters.certifications.includes(cert) ? 'default' : 'outline'}
                      className="cursor-pointer hover:bg-primary/80 text-xs"
                      onClick={() => toggleCertification(cert)}
                    >
                      {cert}
                      {filters.certifications.includes(cert) && (
                        <X className="h-3 w-3 ml-1" />
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Verified Only */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="verified"
                checked={filters.verifiedOnly}
                onCheckedChange={(checked) => 
                  onChange({ ...filters, verifiedOnly: checked === true })
                }
              />
              <label
                htmlFor="verified"
                className="text-sm font-medium leading-none cursor-pointer"
              >
                Verified trainers only
              </label>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export { DEFAULT_FILTERS };
