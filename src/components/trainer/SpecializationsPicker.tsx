import { useState, useEffect } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { Specialization, getSpecializations } from '@/lib/certifications';

interface SpecializationsPickerProps {
  selectedSpecializations: string[];
  onChange: (specializations: string[]) => void;
  disabled?: boolean;
}

export function SpecializationsPicker({
  selectedSpecializations,
  onChange,
  disabled = false,
}: SpecializationsPickerProps) {
  const [open, setOpen] = useState(false);
  const [specializations, setSpecializations] = useState<Specialization[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSpecializations() {
      setLoading(true);
      const specs = await getSpecializations();
      setSpecializations(specs);
      setLoading(false);
    }
    fetchSpecializations();
  }, []);

  const toggleSpecialization = (specName: string) => {
    if (selectedSpecializations.includes(specName)) {
      onChange(selectedSpecializations.filter(s => s !== specName));
    } else {
      onChange([...selectedSpecializations, specName]);
    }
  };

  const removeSpecialization = (specName: string) => {
    onChange(selectedSpecializations.filter(s => s !== specName));
  };

  return (
    <div className="space-y-2">
      {/* Selected specializations as badges */}
      {selectedSpecializations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedSpecializations.map(specName => (
            <Badge
              key={specName}
              variant="secondary"
              className="gap-1 pr-1"
            >
              {specName}
              <button
                type="button"
                onClick={() => removeSpecialization(specName)}
                className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5"
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Picker popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={disabled || loading}
          >
            {loading ? (
              'Loading...'
            ) : selectedSpecializations.length > 0 ? (
              `${selectedSpecializations.length} specialization${selectedSpecializations.length > 1 ? 's' : ''} selected`
            ) : (
              'Select specializations...'
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search specializations..." />
            <CommandList className="max-h-[300px]">
              <CommandEmpty>No specializations found.</CommandEmpty>
              <CommandGroup>
                {specializations.map(spec => (
                  <CommandItem
                    key={spec.id}
                    value={spec.name}
                    onSelect={() => toggleSpecialization(spec.name)}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        selectedSpecializations.includes(spec.name)
                          ? "opacity-100"
                          : "opacity-0"
                      )}
                    />
                    <div className="flex-1">
                      <span>{spec.name}</span>
                      {spec.description && (
                        <p className="text-xs text-muted-foreground">
                          {spec.description}
                        </p>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
