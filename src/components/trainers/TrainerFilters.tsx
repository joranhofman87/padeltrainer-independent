import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SlidersHorizontal, X, Star } from 'lucide-react';

export interface TrainerFiltersState {
  priceRange: [number, number];
  minRating: number;
  specializations: string[];
  minExperience: number;
  location: string;
  verifiedOnly: boolean;
}

interface TrainerFiltersProps {
  filters: TrainerFiltersState;
  onChange: (filters: TrainerFiltersState) => void;
  locations: string[];
  allSpecializations: string[];
  activeFilterCount: number;
}

const DEFAULT_FILTERS: TrainerFiltersState = {
  priceRange: [0, 200],
  minRating: 0,
  specializations: [],
  minExperience: 0,
  location: 'all',
  verifiedOnly: false,
};

export function TrainerFilters({
  filters,
  onChange,
  locations,
  allSpecializations,
  activeFilterCount,
}: TrainerFiltersProps) {
  const [open, setOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState(filters);

  const handleOpen = (isOpen: boolean) => {
    if (isOpen) {
      setLocalFilters(filters);
    }
    setOpen(isOpen);
  };

  const handleApply = () => {
    onChange(localFilters);
    setOpen(false);
  };

  const handleReset = () => {
    setLocalFilters(DEFAULT_FILTERS);
    onChange(DEFAULT_FILTERS);
    setOpen(false);
  };

  const toggleSpecialization = (spec: string) => {
    setLocalFilters(prev => ({
      ...prev,
      specializations: prev.specializations.includes(spec)
        ? prev.specializations.filter(s => s !== spec)
        : [...prev.specializations, spec],
    }));
  };

  return (
    <Sheet open={open} onOpenChange={handleOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" className="gap-2">
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 w-5 p-0 flex items-center justify-center">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Filter Trainers</SheetTitle>
          <SheetDescription>
            Narrow down your search to find the perfect trainer
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 py-6">
          {/* Location */}
          <div className="space-y-2">
            <Label>Location</Label>
            <Select
              value={localFilters.location}
              onValueChange={(value) => setLocalFilters(prev => ({ ...prev, location: value }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {locations.map(loc => (
                  <SelectItem key={loc} value={loc}>{loc}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Price Range */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label>Price Range</Label>
              <span className="text-sm text-muted-foreground">
                €{localFilters.priceRange[0]} - €{localFilters.priceRange[1]}
              </span>
            </div>
            <Slider
              value={localFilters.priceRange}
              onValueChange={(value) => setLocalFilters(prev => ({ ...prev, priceRange: value as [number, number] }))}
              min={0}
              max={200}
              step={5}
              className="w-full"
            />
            <div className="flex gap-2">
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">Min</Label>
                <Input
                  type="number"
                  value={localFilters.priceRange[0]}
                  onChange={(e) => setLocalFilters(prev => ({
                    ...prev,
                    priceRange: [Number(e.target.value), prev.priceRange[1]]
                  }))}
                  className="h-8"
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs text-muted-foreground">Max</Label>
                <Input
                  type="number"
                  value={localFilters.priceRange[1]}
                  onChange={(e) => setLocalFilters(prev => ({
                    ...prev,
                    priceRange: [prev.priceRange[0], Number(e.target.value)]
                  }))}
                  className="h-8"
                />
              </div>
            </div>
          </div>

          {/* Minimum Rating */}
          <div className="space-y-3">
            <Label>Minimum Rating</Label>
            <div className="flex gap-2">
              {[0, 3, 4, 4.5].map((rating) => (
                <Button
                  key={rating}
                  variant={localFilters.minRating === rating ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => setLocalFilters(prev => ({ ...prev, minRating: rating }))}
                >
                  {rating === 0 ? 'Any' : (
                    <span className="flex items-center gap-1">
                      {rating}+ <Star className="h-3 w-3 fill-current" />
                    </span>
                  )}
                </Button>
              ))}
            </div>
          </div>

          {/* Minimum Experience */}
          <div className="space-y-3">
            <Label>Minimum Experience</Label>
            <div className="flex gap-2 flex-wrap">
              {[0, 1, 3, 5, 10].map((years) => (
                <Button
                  key={years}
                  variant={localFilters.minExperience === years ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setLocalFilters(prev => ({ ...prev, minExperience: years }))}
                >
                  {years === 0 ? 'Any' : `${years}+ years`}
                </Button>
              ))}
            </div>
          </div>

          {/* Specializations */}
          {allSpecializations.length > 0 && (
            <div className="space-y-3">
              <Label>Specializations</Label>
              <div className="flex flex-wrap gap-2">
                {allSpecializations.map((spec) => (
                  <Badge
                    key={spec}
                    variant={localFilters.specializations.includes(spec) ? 'default' : 'outline'}
                    className="cursor-pointer hover:bg-primary/80"
                    onClick={() => toggleSpecialization(spec)}
                  >
                    {spec}
                    {localFilters.specializations.includes(spec) && (
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
              checked={localFilters.verifiedOnly}
              onCheckedChange={(checked) => 
                setLocalFilters(prev => ({ ...prev, verifiedOnly: checked === true }))
              }
            />
            <label
              htmlFor="verified"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Verified trainers only
            </label>
          </div>
        </div>

        <SheetFooter className="flex gap-2 sm:flex-row">
          <Button variant="outline" onClick={handleReset} className="flex-1">
            Reset
          </Button>
          <Button onClick={handleApply} className="flex-1">
            Apply Filters
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export { DEFAULT_FILTERS };
