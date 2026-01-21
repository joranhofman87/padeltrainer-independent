import { useState, useEffect, useMemo } from 'react';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  Certification,
  getCertifications,
  groupCertificationsByCountry,
  getCountryInfo,
} from '@/lib/certifications';

interface CertificationsPickerProps {
  selectedCertifications: string[];
  onChange: (certifications: string[]) => void;
  trainerCountry?: string;
  disabled?: boolean;
}

export function CertificationsPicker({
  selectedCertifications,
  onChange,
  trainerCountry = 'NL',
  disabled = false,
}: CertificationsPickerProps) {
  const [open, setOpen] = useState(false);
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCountries, setExpandedCountries] = useState<Set<string>>(
    new Set([trainerCountry, 'INT'])
  );

  useEffect(() => {
    async function fetchCertifications() {
      setLoading(true);
      const certs = await getCertifications();
      setCertifications(certs);
      setLoading(false);
    }
    fetchCertifications();
  }, []);

  // Update expanded countries when trainer country changes
  useEffect(() => {
    setExpandedCountries(new Set([trainerCountry, 'INT']));
  }, [trainerCountry]);

  const groupedCertifications = useMemo(() => {
    return groupCertificationsByCountry(certifications, trainerCountry);
  }, [certifications, trainerCountry]);

  const toggleCertification = (certName: string) => {
    if (selectedCertifications.includes(certName)) {
      onChange(selectedCertifications.filter(c => c !== certName));
    } else {
      onChange([...selectedCertifications, certName]);
    }
  };

  const removeCertification = (certName: string) => {
    onChange(selectedCertifications.filter(c => c !== certName));
  };

  const toggleCountryExpanded = (country: string) => {
    const newExpanded = new Set(expandedCountries);
    if (newExpanded.has(country)) {
      newExpanded.delete(country);
    } else {
      newExpanded.add(country);
    }
    setExpandedCountries(newExpanded);
  };

  // Get certification info for a selected name
  const getCertificationInfo = (name: string): Certification | undefined => {
    return certifications.find(c => c.name === name);
  };

  return (
    <div className="space-y-2">
      {/* Selected certifications as badges */}
      {selectedCertifications.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedCertifications.map(certName => {
            const cert = getCertificationInfo(certName);
            const countryInfo = cert ? getCountryInfo(cert.country) : null;
            return (
              <Badge
                key={certName}
                variant="secondary"
                className="gap-1 pr-1"
              >
                {countryInfo && <span>{countryInfo.flag}</span>}
                {certName}
                <button
                  type="button"
                  onClick={() => removeCertification(certName)}
                  className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5"
                  disabled={disabled}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
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
            ) : selectedCertifications.length > 0 ? (
              `${selectedCertifications.length} certification${selectedCertifications.length > 1 ? 's' : ''} selected`
            ) : (
              'Select certifications...'
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[350px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search certifications..." />
            <CommandList className="max-h-[400px]">
              <CommandEmpty>No certifications found.</CommandEmpty>
              
              {Array.from(groupedCertifications.entries()).map(([country, certs]) => {
                const countryInfo = getCountryInfo(country);
                const isExpanded = expandedCountries.has(country);
                const isPriorityCountry = country === trainerCountry;
                const selectedInCountry = certs.filter(c => 
                  selectedCertifications.includes(c.name)
                ).length;

                return (
                  <Collapsible
                    key={country}
                    open={isExpanded}
                    onOpenChange={() => toggleCountryExpanded(country)}
                  >
                    <CollapsibleTrigger asChild>
                      <div
                        className={cn(
                          "flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-accent",
                          isPriorityCountry && "bg-primary/5"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span>{countryInfo.flag}</span>
                          <span className="font-medium text-sm">
                            {countryInfo.name}
                            {isPriorityCountry && (
                              <span className="text-xs text-muted-foreground ml-1">
                                (Your region)
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {selectedInCountry > 0 && (
                            <Badge variant="secondary" className="h-5 min-w-[20px] px-1.5">
                              {selectedInCountry}
                            </Badge>
                          )}
                          <ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CommandGroup>
                        {certs.map(cert => (
                          <CommandItem
                            key={cert.id}
                            value={cert.name}
                            onSelect={() => toggleCertification(cert.name)}
                            className="pl-8"
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedCertifications.includes(cert.name)
                                  ? "opacity-100"
                                  : "opacity-0"
                              )}
                            />
                            <div className="flex-1">
                              <span>{cert.name}</span>
                              {cert.description && (
                                <p className="text-xs text-muted-foreground">
                                  {cert.description}
                                </p>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
