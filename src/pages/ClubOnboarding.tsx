import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { Building2, Search, MapPin, Check } from 'lucide-react';
import { getActiveLocations, Location } from '@/lib/locations';
import { claimClub, isLocationClaimed } from '@/lib/club';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { validatePhone } from '@/lib/validation';

export default function ClubOnboarding() {
  const [isLoading, setIsLoading] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [locationOpen, setLocationOpen] = useState(false);
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [isAlreadyClaimed, setIsAlreadyClaimed] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, profile, loading } = useAuth();
  const { t } = useTranslation('club');

  useEffect(() => {
    if (!loading && !user) {
      navigate('/signup/club');
    }
  }, [user, loading, navigate]);

  // Assign club role immediately when user lands on the page
  useEffect(() => {
    const assignClubRole = async () => {
      if (user && sessionStorage.getItem('pendingRole') === 'club') {
        try {
          const { error } = await supabase
            .from('user_roles')
            .insert({ user_id: user.id, role: 'club' });
          
          // Clear pending role if successful or if it's a duplicate (23505 = unique violation)
          if (!error || error.code === '23505') {
            sessionStorage.removeItem('pendingRole');
          }
        } catch (err) {
          console.error('Error assigning club role:', err);
        }
      }
    };
    assignClubRole();
  }, [user]);

  useEffect(() => {
    const fetchLocations = async () => {
      const data = await getActiveLocations();
      setLocations(data);
    };
    fetchLocations();
  }, []);

  useEffect(() => {
    // Pre-fill contact email from user profile
    if (profile?.email) {
      setContactEmail(profile.email);
    } else if (user?.email) {
      setContactEmail(user.email);
    }
  }, [profile, user]);

  useEffect(() => {
    const checkClaimed = async () => {
      if (selectedLocation) {
        const claimed = await isLocationClaimed(selectedLocation.id);
        setIsAlreadyClaimed(claimed);
      } else {
        setIsAlreadyClaimed(false);
      }
    };
    checkClaimed();
  }, [selectedLocation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedLocation) {
      toast({
        title: t('claim.error', 'Error'),
        description: t('claim.selectLocation', 'Please select a location'),
        variant: 'destructive',
      });
      return;
    }

    if (!contactEmail) {
      toast({
        title: t('claim.error', 'Error'),
        description: t('claim.emailRequired', 'Contact email is required'),
        variant: 'destructive',
      });
      return;
    }

    // Validate session is ready before making the claim
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      toast({
        title: t('claim.error', 'Error'),
        description: t('claim.sessionExpired', 'Your session has expired. Please refresh the page and try again.'),
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    try {
      const { success, error } = await claimClub(selectedLocation.id, session.user.id, contactEmail, contactPhone, description);
      
      if (error || !success) {
        throw error || new Error('Failed to submit claim');
      }
      
      // Clear the pending role since they've completed the club flow
      sessionStorage.removeItem('pendingRole');
      
      toast({
        title: t('claim.success', 'Claim Submitted!'),
        description: t('claim.successDescription', 'Your claim is pending verification. We will review it shortly.'),
      });
      
      navigate('/club');
    } catch (error: any) {
      console.error('Club claim error:', error);
      toast({
        title: t('claim.error', 'Error'),
        description: error.message || t('claim.errorDescription', 'Failed to submit claim'),
        variant: 'destructive',
      });
    }

    setIsLoading(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900">
            <Building2 className="h-8 w-8 text-green-600 dark:text-green-400" />
          </div>
          <CardTitle className="text-2xl font-bold">
            {t('onboarding.title', 'Find Your Club')}
          </CardTitle>
          <CardDescription>
            {t('onboarding.subtitle', 'Search for your club and claim it to start managing')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Location Picker */}
            <div className="space-y-2">
              <Label>{t('onboarding.selectClub', 'Select Your Club')}</Label>
              <Popover open={locationOpen} onOpenChange={setLocationOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={locationOpen}
                    className="w-full justify-between h-12"
                  >
                    {selectedLocation ? (
                      <div className="flex items-center gap-2 text-left">
                        <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div className="truncate">
                          <span className="font-medium">{selectedLocation.name}</span>
                          <span className="text-muted-foreground ml-2">
                            {selectedLocation.city}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground flex items-center gap-2">
                        <Search className="h-4 w-4" />
                        {t('onboarding.searchPlaceholder', 'Search for your club...')}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t('onboarding.searchPlaceholder', 'Search for your club...')} />
                    <CommandList>
                      <CommandEmpty>{t('onboarding.noClubFound', 'No club found')}</CommandEmpty>
                      <CommandGroup>
                        {locations.map((location) => (
                          <CommandItem
                            key={location.id}
                            value={`${location.name} ${location.city}`}
                            onSelect={() => {
                              setSelectedLocation(location);
                              setLocationOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedLocation?.id === location.id ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex flex-col">
                              <span className="font-medium">{location.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {location.city}, {location.country}
                              </span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {isAlreadyClaimed && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  {t('onboarding.alreadyClaimed', 'This club has already been claimed. Contact support if you believe this is an error.')}
                </p>
              )}
            </div>

            {selectedLocation && !isAlreadyClaimed && (
              <>
                {/* Contact Email */}
                <div className="space-y-2">
                  <Label htmlFor="contact-email">
                    {t('claim.contactEmail', 'Contact Email')} *
                  </Label>
                  <Input
                    id="contact-email"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder={t('claim.emailPlaceholder', 'club@example.com')}
                    required
                  />
                </div>

                {/* Contact Phone */}
                <div className="space-y-2">
                  <Label htmlFor="contact-phone">
                    {t('claim.contactPhone', 'Contact Phone')}
                  </Label>
                  <Input
                    id="contact-phone"
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => {
                      setContactPhone(e.target.value);
                      setPhoneError(null);
                    }}
                    onBlur={() => {
                      const error = validatePhone(contactPhone);
                      setPhoneError(error ? t(`auth:${error}`) : null);
                    }}
                    placeholder={t('claim.phonePlaceholder', '+31 6 12345678')}
                    className={phoneError ? 'border-destructive' : ''}
                  />
                  {phoneError && (
                    <p className="text-xs text-destructive">{phoneError}</p>
                  )}
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="description">
                    {t('claim.description', 'Tell us about your role')}
                  </Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('claim.descriptionPlaceholder', 'I am the owner/manager of this club...')}
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('claim.descriptionHelp', 'This helps us verify your claim faster')}
                  </p>
                </div>

                <Button type="submit" className="w-full" disabled={isLoading || !selectedLocation}>
                  {isLoading ? t('claim.submitting', 'Submitting...') : t('claim.submitClaim', 'Claim This Club')}
                </Button>
              </>
            )}

            {!selectedLocation && (
              <div className="rounded-lg bg-muted/50 p-4 text-center">
                <p className="text-sm text-muted-foreground">
                  {t('onboarding.cantFindClub', "Can't find your club?")}{' '}
                  <a 
                    href="mailto:info@padeltrainer.ai?subject=Add%20my%20club&body=Hi%20Team%2C%0A%0ACould%20you%20add%20my%20club%20XXX.%0A%0ASee%20here%20all%20details%3A%20ADD%20WEBSITE%20LINK"
                    className="text-primary hover:underline font-medium"
                  >
                    {t('onboarding.contactUs', 'Contact us')}
                  </a>{' '}
                  {t('onboarding.andWeWillAddIt', "and we'll add it.")}
                </p>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
