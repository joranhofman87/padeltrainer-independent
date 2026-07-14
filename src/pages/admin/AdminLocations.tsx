import { useState, useEffect, useMemo } from 'react';
import { isUserAdmin, importPipelineData, type ImportPipelineSummary } from '@/lib/admin';
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
  Download,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { ImportLocationsDialog } from '@/components/admin/ImportLocationsDialog';
import { LocationEditDialog } from '@/components/admin/LocationEditDialog';
import { DataProcessingDialog, DataProcessingBadge } from '@/components/admin/DataProcessingDialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { SelectFilter } from '@/components/ui/select-filter';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  getAllLocations,
  updateLocation,
  getLocationTrainerCounts,
  getUniqueCities,
  type Location,
} from '@/lib/locations';
import { useTableSort } from '@/hooks/useTableSort';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';

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
  const [dataProcessingOpen, setDataProcessingOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [importingPipeline, setImportingPipeline] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<ImportPipelineSummary | null>(null);

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
        const { data: verifiedClubs } = await supabase
          .from('club_profiles')
          .select('location_id')
          .eq('is_verified', true);
        
        if (verifiedClubs) {
          setVerifiedLocationIds(new Set(verifiedClubs.map(c => c.location_id)));
        }
      } catch (error) {
        logger.error('Error fetching locations', error as Error, { component: 'AdminLocations' });
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

  const exportToCsv = () => {
    const headers = [
      'Name', 'Street Address', 'Postal Code', 'City', 'Country',
      'Website', 'Phone', 'Email', 'Indoor Courts', 'Outdoor Courts',
      'Google Maps URL', 'Google Rating', 'Google Reviews',
      'Facebook', 'Instagram', 'Latitude', 'Longitude',
      'Verified', 'Active', 'Trainers', 'Slug', 'Created At',
    ];

    const escCsv = (val: unknown) => {
      if (val == null) return '';
      const s = String(val);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = sortedData.map(loc => [
      loc.name, loc.street_address, loc.postal_code, loc.city, loc.country,
      loc.website_url, loc.phone, loc.email,
      loc.indoor_courts, loc.outdoor_courts,
      loc.google_maps_url, loc.google_rating, loc.google_review_count,
      loc.facebook_url, loc.instagram_url, loc.latitude, loc.longitude,
      loc._isVerified ? 'Yes' : 'No', loc.is_active ? 'Yes' : 'No',
      loc._trainerCount, loc.slug, loc.created_at,
    ].map(escCsv).join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `locations-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openAddDialog = () => {
    setEditingLocation(null);
    setDialogOpen(true);
  };

  const openEditDialog = (location: Location) => {
    setEditingLocation(location);
    setDialogOpen(true);
  };

  const handleDialogSuccess = async () => {
    const locationsData = await getAllLocations();
    setLocations(locationsData);
  };

  const handlePipelineImport = async (dryRun: boolean) => {
    setImportingPipeline(true);
    setPipelineResult(null);
    try {
      const result = await importPipelineData({ dry_run: dryRun });
      setPipelineResult(result);
      toast({
        title: dryRun ? 'Dry Run Complete' : 'Import Complete',
        description: `Locations: ${result.inserted_locations} inserted, Academies: ${result.inserted_academies} inserted, Linked: ${result.linked}, Skipped: ${result.skipped_duplicate} dupes + ${result.skipped_invalid} invalid`,
      });
    } catch (error) {
      toast({
        title: 'Import Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setImportingPipeline(false);
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
    } catch {
      toast({
        title: 'Error',
        description: 'Failed to update location',
        variant: 'destructive',
      });
    }
  };

  const columns: ColumnDef<LocationWithComputedFields>[] = [
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      className: "max-w-[260px]",
      cellTitle: (location) => location.name,
      renderCell: (location) => {
        const enrichment = location as { enrichment_failed_at?: string; enrichment_error_msg?: string };
        return (
          <div className="flex items-center gap-2">
            {location.logo_url ? (
              <img src={location.logo_url} alt="" className="h-4 w-4 shrink-0 object-contain" />
            ) : (
              <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium truncate">{location.name}</span>
            {enrichment.enrichment_failed_at && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-medium">Enrichment failed</p>
                    <p className="text-xs">{enrichment.enrichment_error_msg || 'Unknown error'}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        );
      },
    },
    {
      key: "city",
      header: "City",
      sortKey: "city",
      className: "max-w-[160px]",
      cellTitle: (location) => location.city,
      renderCell: (location) => <span className="block truncate">{location.city}</span>,
    },
    {
      key: "number_of_courts",
      header: "Courts",
      sortKey: "number_of_courts",
      align: "center",
      className: "text-sm whitespace-nowrap",
      renderCell: (location) => (
        <>
          {(location.indoor_courts || 0) > 0 && <span title="Indoor">🏠{location.indoor_courts}</span>}
          {(location.indoor_courts || 0) > 0 && (location.outdoor_courts || 0) > 0 && ' / '}
          {(location.outdoor_courts || 0) > 0 && <span title="Outdoor">☀️{location.outdoor_courts}</span>}
          {!(location.indoor_courts || location.outdoor_courts) && '-'}
        </>
      ),
    },
    {
      key: "_trainerCount",
      header: "Trainers",
      sortKey: "_trainerCount",
      align: "center",
      renderCell: (location) => <Badge variant="secondary">{trainerCounts[location.id] || 0}</Badge>,
    },
    {
      key: "_isVerified",
      header: "Verified",
      sortKey: "_isVerified",
      align: "center",
      renderCell: (location) =>
        location._isVerified ? (
          <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto" />
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      key: "is_active",
      header: "Status",
      sortKey: "is_active",
      align: "center",
      renderCell: (location) => (
        <Badge variant={location.is_active ? 'default' : 'outline'}>
          {location.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  const renderLocationActions = (location: LocationWithComputedFields) => (
    <>
      {location.website_url && (
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open in new tab" onClick={() => window.open(location.website_url!, '_blank')}>
          <ExternalLink className="h-4 w-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit" onClick={() => openEditDialog(location)}>
        <Edit className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={location.is_active ? 'Deactivate' : 'Activate'} onClick={() => toggleActive(location)}>
        {location.is_active ? (
          <ToggleRight className="h-4 w-4 text-green-500" />
        ) : (
          <ToggleLeft className="h-4 w-4" />
        )}
      </Button>
    </>
  );

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
        <div className="flex items-center gap-2 flex-wrap">
          <DataProcessingBadge onClick={() => setDataProcessingOpen(true)} />
          <Button variant="outline" onClick={exportToCsv}>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
          <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
            <Upload className="h-4 w-4 mr-2" />
            Import CSV
          </Button>
          <Button onClick={openAddDialog}>
            <Plus className="h-4 w-4 mr-2" />
            Add Location
          </Button>
        </div>
      </div>

      {/* Temporary: Pipeline Import */}
      <div className="rounded-lg border border-dashed border-orange-500/50 bg-orange-500/5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-sm">🔧 Pipeline Import (temporary)</p>
            <p className="text-xs text-muted-foreground">Pull locations & academies from data pipeline</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePipelineImport(true)}
              disabled={importingPipeline}
            >
              {importingPipeline ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Dry Run
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => handlePipelineImport(false)}
              disabled={importingPipeline}
            >
              {importingPipeline ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Import Now
            </Button>
          </div>
        </div>
        {pipelineResult && (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <div className="rounded bg-muted p-2">
              <div className="font-medium">{pipelineResult.inserted_locations}</div>
              <div className="text-muted-foreground">Locations</div>
            </div>
            <div className="rounded bg-muted p-2">
              <div className="font-medium">{pipelineResult.inserted_academies}</div>
              <div className="text-muted-foreground">Academies</div>
            </div>
            <div className="rounded bg-muted p-2">
              <div className="font-medium">{pipelineResult.linked}</div>
              <div className="text-muted-foreground">Linked</div>
            </div>
            <div className="rounded bg-muted p-2">
              <div className="font-medium">{pipelineResult.skipped_duplicate}</div>
              <div className="text-muted-foreground">Duplicates</div>
            </div>
            <div className="rounded bg-muted p-2">
              <div className="font-medium">{pipelineResult.skipped_invalid}</div>
              <div className="text-muted-foreground">Invalid</div>
            </div>
          </div>
        )}
      </div>

      {/* Location Edit Dialog */}
      <LocationEditDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        location={editingLocation}
        onSuccess={handleDialogSuccess}
      />

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
          <SelectFilter
            value={selectedCity}
            onValueChange={setSelectedCity}
            allLabel="All cities"
            options={cities.map(city => ({ value: city, label: city }))}
            placeholder="Filter by city"
            triggerClassName="w-[180px]"
          />
          <SelectFilter
            value={verifiedFilter}
            onValueChange={setVerifiedFilter}
            allLabel="All"
            options={[
              { value: 'yes', label: 'Verified' },
              { value: 'no', label: 'Not Verified' },
            ]}
            placeholder="Verified"
            triggerClassName="w-[150px]"
          />
          <Button
            variant={showInactive ? 'default' : 'outline'}
            onClick={() => setShowInactive(!showInactive)}
          >
            {showInactive ? 'Hide Inactive' : 'Show Inactive'}
          </Button>
        </div>
      </div>

      {/* Data Table */}
      <DataTable<LocationWithComputedFields>
        columns={columns}
        rows={sortedData}
        sortKey={sortConfig.key as string | null}
        sortDirection={sortConfig.direction}
        onSort={(key) => handleSort(key as keyof LocationWithComputedFields)}
        renderActions={renderLocationActions}
        rowClassName={(location) => (!location.is_active ? 'opacity-50' : undefined)}
        compact
        desktopOnly={false}
        empty="No locations found"
      />

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

      {/* Data Processing Dialog */}
      <DataProcessingDialog
        open={dataProcessingOpen}
        onOpenChange={setDataProcessingOpen}
        onSuccess={async () => {
          const locationsData = await getAllLocations();
          setLocations(locationsData);
        }}
      />
    </div>
  );
}
