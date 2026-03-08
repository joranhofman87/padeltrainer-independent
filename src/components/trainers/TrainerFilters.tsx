import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
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
import { SlidersHorizontal, X, Star, MapPin, Check, ChevronsUpDown, ChevronDown, ChevronUp, RotateCcw, CalendarCheck } from 'lucide-react';
import { Location } from '@/lib/locations';
import { cn } from '@/lib/utils';

export interface RatingSystem {
  code: string;
  name: string;
  min_rating: number;
  max_rating: number;
  lower_is_better: boolean;
  step: number;
}

export interface TrainerFiltersState {
  priceRange: [number, number];
  minRating: number;
  specializations: string[];
  certifications: string[];
  minExperience: number;
  locationId: string;
  verifiedOnly: boolean;
  ratingSystem: string;
  minTrainerRating: number;
  hasAvailability: boolean;
}

interface TrainerFiltersProps {
  filters: TrainerFiltersState;
  onChange: (filters: TrainerFiltersState) => void;
  locations: Location[];
  allSpecializations: string[];
  allCertifications: string[];
  ratingSystems: RatingSystem[];
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
  ratingSystem: '',
  minTrainerRating: 0,
  hasAvailability: false,
};

export function TrainerFilters({
  filters,
  onChange,
  locations,
  allSpecializations,
  allCertifications,
  ratingSystems,
  activeFilterCount,
}: TrainerFiltersProps) {
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<string>('all');
  const [isExpanded, setIsExpanded] = useState(false);

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

  // Get selected rating system details
  const selectedRatingSystem = useMemo(() => {
    return ratingSystems.find(rs => rs.code === filters.ratingSystem);
  }, [filters.ratingSystem, ratingSystems]);

  // Generate rating options based on selected system
  const ratingOptions = useMemo(() => {
    if (!selectedRatingSystem) return [];
    const { min_rating, max_rating, lower_is_better, step } = selectedRatingSystem;
    const options: number[] = [0]; // 0 = Any
    
    if (lower_is_better) {
      // For lower_is_better (like KNLTB), show lower values as "better"
      // User wants trainers with rating <= X
      const values = [8, 7, 6, 5, 4, 3].filter(v => v >= min_rating && v <= max_rating);
      options.push(...values);
    } else {
      // For higher_is_better (like Playtomic), show higher values
      // User wants trainers with rating >= X
      if (max_rating <= 10) {
        const values = [2, 3, 4, 5, 6].filter(v => v >= min_rating && v <= max_rating);
        options.push(...values);
      } else {
        // For large ranges like Tennis Vlaanderen (50-1000)
        const values = [100, 200, 300, 500, 700].filter(v => v >= min_rating && v <= max_rating);
        options.push(...values);
      }
    }
    return options;
  }, [selectedRatingSystem]);

  return (
    <Card className="w-full">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardContent className="py-4">
          {/* Always visible: Primary filters row */}
          <div className="flex flex-wrap items-end gap-3">
            {/* Location */}
            <div className="flex-1 min-w-[180px] max-w-[250px] space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Location</Label>
              <Popover open={locationOpen} onOpenChange={setLocationOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={locationOpen}
                    className="w-full justify-between h-9 text-sm"
                  >
                    {selectedLocation ? (
                      <span className="flex items-center gap-1.5 truncate">
                        <MapPin className="h-3 w-3 shrink-0" />
                        <span className="truncate">{selectedLocation.name}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">All locations</span>
                    )}
                    <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[280px] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput 
                      placeholder="Search clubs..." 
                      value={locationSearch}
                      onValueChange={setLocationSearch}
                    />
                    {availableCountries.length > 1 && (
                      <div className="p-2 border-b">
                        <Select value={selectedCountry} onValueChange={setSelectedCountry}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="All Countries" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Countries</SelectItem>
                            {availableCountries.map(country => (
                              <SelectItem key={country} value={country}>{country}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
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
            </div>

            {/* Price Range */}
            <div className="flex-1 min-w-[140px] max-w-[180px] space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                Price (€{filters.priceRange[0]}-€{filters.priceRange[1]})
              </Label>
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  value={filters.priceRange[0]}
                  onChange={(e) => onChange({
                    ...filters,
                    priceRange: [Number(e.target.value), filters.priceRange[1]]
                  })}
                  className="h-9 text-sm w-16"
                  placeholder="Min"
                />
                <Input
                  type="number"
                  value={filters.priceRange[1]}
                  onChange={(e) => onChange({
                    ...filters,
                    priceRange: [filters.priceRange[0], Number(e.target.value)]
                  })}
                  className="h-9 text-sm w-16"
                  placeholder="Max"
                />
              </div>
            </div>

            {/* Min Review Rating */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Min Reviews</Label>
              <div className="flex gap-1">
                {[0, 3, 4, 4.5].map((rating) => (
                  <Button
                    key={rating}
                    variant={filters.minRating === rating ? 'default' : 'outline'}
                    size="sm"
                    className="h-9 text-xs px-2"
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

            {/* Trainer Rating System */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Trainer Level</Label>
              <div className="flex gap-1.5">
                <Select 
                  value={filters.ratingSystem || 'any'} 
                  onValueChange={(v) => onChange({ ...filters, ratingSystem: v === 'any' ? '' : v, minTrainerRating: 0 })}
                >
                  <SelectTrigger className="h-9 text-sm w-[100px]">
                    <SelectValue placeholder="System" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any</SelectItem>
                    {ratingSystems.map(rs => (
                      <SelectItem key={rs.code} value={rs.code}>{rs.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedRatingSystem && ratingOptions.length > 1 && (
                  <Select 
                    value={String(filters.minTrainerRating)} 
                    onValueChange={(v) => onChange({ ...filters, minTrainerRating: Number(v) })}
                  >
                    <SelectTrigger className="h-9 text-sm w-[80px]">
                      <SelectValue placeholder="Level" />
                    </SelectTrigger>
                    <SelectContent>
                      {ratingOptions.map(val => (
                        <SelectItem key={val} value={String(val)}>
                          {val === 0 ? 'Any' : (
                            selectedRatingSystem.lower_is_better ? `≤${val}` : `≥${val}`
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* Has Availability Toggle */}
            <div className="flex items-center space-x-2 self-end pb-0.5">
              <Checkbox
                id="hasAvailability"
                checked={filters.hasAvailability}
                onCheckedChange={(checked) => 
                  onChange({ ...filters, hasAvailability: checked === true })
                }
              />
              <label
                htmlFor="hasAvailability"
                className="text-sm font-medium leading-none cursor-pointer flex items-center gap-1"
              >
                <CalendarCheck className="h-3.5 w-3.5 text-primary" />
                Available
              </label>
            </div>

            {/* More Filters Toggle */}
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-1.5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                More
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="h-4 w-4 p-0 flex items-center justify-center text-[10px]">
                    {activeFilterCount}
                  </Badge>
                )}
                {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </Button>
            </CollapsibleTrigger>

            {/* Reset */}
            {activeFilterCount > 0 && (
              <Button variant="ghost" size="sm" onClick={handleReset} className="h-9 text-xs gap-1">
                <RotateCcw className="h-3 w-3" />
                Reset
              </Button>
            )}
          </div>

          {/* Expanded: Additional filters */}
          <CollapsibleContent>
            <div className="mt-4 pt-4 border-t space-y-4">
              <div className="flex flex-wrap gap-6">
                {/* Experience */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">Experience</Label>
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

                {/* Verified Only */}
                <div className="flex items-center space-x-2 pt-5">
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
                    Verified only
                  </label>
                </div>
              </div>

              {/* Specializations */}
              {allSpecializations.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">Specializations</Label>
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
                  <Label className="text-xs font-medium text-muted-foreground">Certifications</Label>
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
            </div>
          </CollapsibleContent>
        </CardContent>
      </Collapsible>
    </Card>
  );
}

export { DEFAULT_FILTERS };
