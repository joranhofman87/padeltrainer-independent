import { useState, useEffect, useMemo } from 'react';
import { isUserAdmin } from '@/lib/admin';
import {
  Loader2,
  Plus,
  Search,
  MapPin,
  ExternalLink,
  Edit,
  ToggleLeft,
  ToggleRight,
  Upload,
  CheckCircle2,
} from 'lucide-react';
import { ImportLocationsDialog } from '@/components/admin/ImportLocationsDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  getAllLocations,
  createLocation,
  updateLocation,
  getLocationTrainerCounts,
  getUniqueCities,
  type Location,
} from '@/lib/locations';
import { SortableTableHead } from '@/components/admin/SortableTableHead';
import { useTableSort } from '@/hooks/useTableSort';

// Extended type to include computed fields for sorting
interface LocationWithComputedFields extends Location {
  _trainerCount: number;
  _isVerified: boolean;
}

export default function AdminLocations() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [cities, setCities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [verifiedFilter, setVerifiedFilter] = useState<string>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    street_address: '',
    postal_code: '',
    city: '',
    country: 'NL',
    website_url: '',
    slug: '',
    is_active: true,
    number_of_courts: null as number | null,
    indoor_courts: 0,
    outdoor_courts: 0,
  });
  const [saving, setSaving] = useState(false);

  // Get verified location IDs from club_profiles
  const [verifiedLocationIds, setVerifiedLocationIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    async function checkAdmin() {
      if (!user) return;
      const adminStatus = await isUserAdmin(user.id);
      setIsAdmin(adminStatus);
      if (!adminStatus) {
        setLoading(false);
      }
    }
    if (user) {
      checkAdmin();
    }
  }, [user]);

  useEffect(() => {
    async function fetchData() {
      if (!isAdmin) return;
      try {
        const [locationsData, countsData, citiesData] = await Promise.all([
          getAllLocations(),
          getLocationTrainerCounts(),
          getUniqueCities(),
        ]);
        setLocations(locationsData);
        setTrainerCounts(countsData);
        setCities(citiesData);

        // Fetch verified club location IDs
        const { supabase } = await import('@/integrations/supabase/client');
        const { data: verifiedClubs } = await supabase
          .from('club_profiles')
          .select('location_id')
          .eq('is_verified', true);
        
        if (verifiedClubs) {
          setVerifiedLocationIds(new Set(verifiedClubs.map(c => c.location_id)));
        }
      } catch (error) {
        console.error('Error fetching locations:', error);
        toast({
          title: 'Error',
          description: 'Failed to load locations',
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    }
    if (isAdmin) {
      fetchData();
    }
  }, [isAdmin, toast]);

  // Prepare data with computed fields for sorting
  const locationsWithComputed = useMemo(() => {
    return locations.map((location) => ({
      ...location,
      _trainerCount: trainerCounts[location.id] || 0,
      _isVerified: verifiedLocationIds.has(location.id),
    }));
  }, [locations, trainerCounts, verifiedLocationIds]);

  const filteredLocations = locationsWithComputed.filter(location => {
    const matchesSearch =
      location.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      location.city.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCity = selectedCity === 'all' || location.city === selectedCity;
    const matchesActive = showInactive || location.is_active;
    const matchesVerified = 
      verifiedFilter === 'all' || 
      (verifiedFilter === 'yes' && location._isVerified) || 
      (verifiedFilter === 'no' && !location._isVerified);
    return matchesSearch && matchesCity && matchesActive && matchesVerified;
  });

  const { sortedData, sortConfig, handleSort } = useTableSort<LocationWithComputedFields>(
    filteredLocations,
    "name"
  );

  const generateSlug = (name: string, city: string) => {
    return `${name}-${city}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  };

  const openAddDialog = () => {
    setEditingLocation(null);
    setFormData({
      name: '',
      street_address: '',
      postal_code: '',
      city: '',
      country: 'NL',
      website_url: '',
      slug: '',
      is_active: true,
      number_of_courts: null,
      indoor_courts: 0,
      outdoor_courts: 0,
    });
    setDialogOpen(true);
  };

  const openEditDialog = (location: Location) => {
    setEditingLocation(location);
    setFormData({
      name: location.name,
      street_address: location.street_address || '',
      postal_code: location.postal_code || '',
      city: location.city,
      country: location.country,
      website_url: location.website_url || '',
      slug: location.slug,
      is_active: location.is_active,
      number_of_courts: location.number_of_courts,
      indoor_courts: location.indoor_courts ?? 0,
      outdoor_courts: location.outdoor_courts ?? 0,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name || !formData.city) {
      toast({
        title: 'Validation Error',
        description: 'Name and city are required',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      const slug = formData.slug || generateSlug(formData.name, formData.city);
      const locationData = {
        ...formData,
        slug,
        street_address: formData.street_address || null,
        postal_code: formData.postal_code || null,
        website_url: formData.website_url || null,
        number_of_courts: formData.number_of_courts ?? null,
        indoor_courts: formData.indoor_courts ?? 0,
        outdoor_courts: formData.outdoor_courts ?? 0,
        description: null,
        logo_url: null,
        latitude: null,
        longitude: null,
        phone: null,
        email: null,
        facebook_url: null,
        instagram_url: null,
        google_maps_url: null,
        google_rating: null,
        google_review_count: null,
        opening_hours: null,
      };

      if (editingLocation) {
        await updateLocation(editingLocation.id, locationData);
        toast({ title: 'Success', description: 'Location updated successfully' });
      } else {
        await createLocation(locationData);
        toast({ title: 'Success', description: 'Location created successfully' });
      }

      const locationsData = await getAllLocations();
      setLocations(locationsData);
      setDialogOpen(false);
    } catch (error: any) {
      console.error('Error saving location:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to save location',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (location: Location) => {
    try {
      await updateLocation(location.id, { is_active: !location.is_active });
      setLocations(prev =>
        prev.map(l => (l.id === location.id ? { ...l, is_active: !l.is_active } : l))
      );
      toast({
        title: 'Success',
        description: `Location ${location.is_active ? 'deactivated' : 'activated'}`,
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to update location',
        variant: 'destructive',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Location Management</h1>
          <p className="text-muted-foreground">
            Manage padel venues · {locations.length} total locations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import CSV
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openAddDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add Location
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingLocation ? 'Edit Location' : 'Add New Location'}</DialogTitle>
                <DialogDescription>
                  {editingLocation
                    ? 'Update the location details below.'
                    : 'Add a new padel venue to the platform.'}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Club name"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="city">City *</Label>
                    <Input
                      id="city"
                      value={formData.city}
                      onChange={e => setFormData(prev => ({ ...prev, city: e.target.value }))}
                      placeholder="City"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="country">Country</Label>
                    <Select
                      value={formData.country}
                      onValueChange={value => setFormData(prev => ({ ...prev, country: value }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NL">Netherlands</SelectItem>
                        <SelectItem value="BE">Belgium</SelectItem>
                        <SelectItem value="DE">Germany</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="street_address">Street Address</Label>
                  <Input
                    id="street_address"
                    value={formData.street_address}
                    onChange={e => setFormData(prev => ({ ...prev, street_address: e.target.value }))}
                    placeholder="Street address"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="postal_code">Postal Code</Label>
                  <Input
                    id="postal_code"
                    value={formData.postal_code}
                    onChange={e => setFormData(prev => ({ ...prev, postal_code: e.target.value }))}
                    placeholder="Postal code"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="website_url">Website URL</Label>
                  <Input
                    id="website_url"
                    value={formData.website_url}
                    onChange={e => setFormData(prev => ({ ...prev, website_url: e.target.value }))}
                    placeholder="https://..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="slug">URL Slug</Label>
                  <Input
                    id="slug"
                    value={formData.slug}
                    onChange={e => setFormData(prev => ({ ...prev, slug: e.target.value }))}
                    placeholder="Auto-generated if empty"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="indoor_courts">Indoor Courts</Label>
                    <Input
                      id="indoor_courts"
                      type="number"
                      min="0"
                      value={formData.indoor_courts}
                      onChange={e => setFormData(prev => ({ ...prev, indoor_courts: parseInt(e.target.value) || 0 }))}
                      placeholder="0"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="outdoor_courts">Outdoor Courts</Label>
                    <Input
                      id="outdoor_courts"
                      type="number"
                      min="0"
                      value={formData.outdoor_courts}
                      onChange={e => setFormData(prev => ({ ...prev, outdoor_courts: parseInt(e.target.value) || 0 }))}
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {editingLocation ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search locations..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Select value={selectedCity} onValueChange={setSelectedCity}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by city" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cities</SelectItem>
              {cities.map(city => (
                <SelectItem key={city} value={city}>
                  {city}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={verifiedFilter} onValueChange={setVerifiedFilter}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Verified" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="yes">Verified</SelectItem>
              <SelectItem value="no">Not Verified</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={showInactive ? 'default' : 'outline'}
            onClick={() => setShowInactive(!showInactive)}
          >
            {showInactive ? 'Hide Inactive' : 'Show Inactive'}
          </Button>
        </div>
      </div>

      {/* Data Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                sortKey="name"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
              >
                Name
              </SortableTableHead>
              <SortableTableHead
                sortKey="city"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
              >
                City
              </SortableTableHead>
              <SortableTableHead
                sortKey="number_of_courts"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
                className="text-center"
              >
                Courts
              </SortableTableHead>
              <SortableTableHead
                sortKey="_trainerCount"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
                className="text-center"
              >
                Trainers
              </SortableTableHead>
              <SortableTableHead
                sortKey="_isVerified"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
                className="text-center"
              >
                Verified
              </SortableTableHead>
              <SortableTableHead
                sortKey="is_active"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
                className="text-center"
              >
                Status
              </SortableTableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLocations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No locations found
                </TableCell>
              </TableRow>
            ) : (
              sortedData.map(location => {
                return (
                <TableRow key={location.id} className={!location.is_active ? 'opacity-50' : ''}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{location.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{location.city}</TableCell>
                  <TableCell className="text-center text-sm">
                    {(location.indoor_courts || 0) > 0 && <span title="Indoor">🏠{location.indoor_courts}</span>}
                    {(location.indoor_courts || 0) > 0 && (location.outdoor_courts || 0) > 0 && ' / '}
                    {(location.outdoor_courts || 0) > 0 && <span title="Outdoor">☀️{location.outdoor_courts}</span>}
                    {!(location.indoor_courts || location.outdoor_courts) && '-'}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="secondary">{trainerCounts[location.id] || 0}</Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {location._isVerified ? (
                      <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto" />
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={location.is_active ? 'default' : 'outline'}>
                      {location.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {location.website_url && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => window.open(location.website_url!, '_blank')}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => openEditDialog(location)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => toggleActive(location)}>
                        {location.is_active ? (
                          <ToggleRight className="h-4 w-4 text-green-500" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer */}
      <p className="text-sm text-muted-foreground">
        Showing {filteredLocations.length} of {locations.length} locations
      </p>

      {/* Import Dialog */}
      <ImportLocationsDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onLocationsImported={async () => {
          const locationsData = await getAllLocations();
          setLocations(locationsData);
        }}
      />
    </div>
  );
}
