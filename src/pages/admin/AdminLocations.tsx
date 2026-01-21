import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { isUserAdmin } from '@/lib/admin';
import {
  ArrowLeft,
  Loader2,
  Plus,
  Search,
  MapPin,
  ExternalLink,
  Edit,
  ToggleLeft,
  ToggleRight,
  ShieldAlert,
} from 'lucide-react';
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
import {
  getAllLocations,
  createLocation,
  updateLocation,
  getLocationTrainerCounts,
  getUniqueCities,
  type Location,
} from '@/lib/locations';

export default function AdminLocations() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [trainerCounts, setTrainerCounts] = useState<Record<string, number>>({});
  const [cities, setCities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
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

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [authLoading, user, navigate]);

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

  const filteredLocations = locations.filter(location => {
    const matchesSearch =
      location.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      location.city.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCity = selectedCity === 'all' || location.city === selectedCity;
    const matchesActive = showInactive || location.is_active;
    return matchesSearch && matchesCity && matchesActive;
  });

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
      };

      if (editingLocation) {
        await updateLocation(editingLocation.id, locationData);
        toast({ title: 'Success', description: 'Location updated successfully' });
      } else {
        await createLocation(locationData);
        toast({ title: 'Success', description: 'Location created successfully' });
      }

      // Refresh data
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

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <ShieldAlert className="h-16 w-16 text-destructive" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">You don't have admin privileges.</p>
        <Button onClick={() => navigate('/')}>Go Home</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center gap-4 px-4 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/admin')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Location Management</h1>
            <p className="text-sm text-muted-foreground">
              Manage padel venues · {locations.length} total locations
            </p>
          </div>
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
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search locations..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
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
          <Button
            variant={showInactive ? 'default' : 'outline'}
            onClick={() => setShowInactive(!showInactive)}
          >
            {showInactive ? 'Hide Inactive' : 'Show Inactive'}
          </Button>
        </div>

        {/* Table */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>City</TableHead>
                <TableHead className="text-center">Courts</TableHead>
                <TableHead className="text-center">Trainers</TableHead>
                <TableHead className="text-center">Status</TableHead>
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
                filteredLocations.map(location => (
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
                      {!(location.indoor_courts || 0) && !(location.outdoor_courts || 0) && '-'}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary">{trainerCounts[location.id] || 0}</Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant={location.is_active ? 'default' : 'secondary'}>
                        {location.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
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
                            <ToggleRight className="h-4 w-4 text-green-600" />
                          ) : (
                            <ToggleLeft className="h-4 w-4 text-muted-foreground" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </main>
    </div>
  );
}
