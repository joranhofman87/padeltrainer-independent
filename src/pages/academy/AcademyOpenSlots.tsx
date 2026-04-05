import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Calendar, ArrowLeft, MapPin, Eye, EyeOff, Euro, X, Users } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useTableSort } from '@/hooks/useTableSort';
import { SortableTableHead } from '@/components/admin/SortableTableHead';
import { formatPrice } from '@/lib/pricing';
import { syncInvoicesAfterPriceChange } from '@/lib/invoiceSync';

interface FlatSlot {
  id: string;
  start_time: string;
  end_time: string;
  max_participants: number;
  booked_count: number;
  available_spots: number;
  cyclus_id: string | null;
  cyclus_name: string | null;
  is_public: boolean;
  location_name: string | null;
  location_id: string | null;
  trainer_id: string | null;
  trainer_name: string | null;
  price_per_session: number | null;
}

export default function AcademyOpenSlots({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const { toast } = useToast();
  const { activeAcademy } = useAcademyContext();
  const [loading, setLoading] = useState(true);
  const [allSlots, setAllSlots] = useState<FlatSlot[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Filters
  const [filterTrainer, setFilterTrainer] = useState('all');
  const [filterLocation, setFilterLocation] = useState('all');
  const [filterCyclus, setFilterCyclus] = useState('all');
  const [filterVisibility, setFilterVisibility] = useState('all');

  // Bulk price dialog
  const [priceDialogOpen, setPriceDialogOpen] = useState(false);
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const dateLocale = i18n.language === 'nl' ? nl : enUS;

  useEffect(() => {
    if (activeAcademy) fetchSlots();
  }, [activeAcademy]);

  const fetchSlots = async () => {
    if (!activeAcademy) return;
    setLoading(true);

    try {
      const { data: academyTrainers } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', activeAcademy.id)
        .eq('status', 'active');

      const trainerIds = academyTrainers?.map(t => t.trainer_profile_id) || [];
      if (trainerIds.length === 0) {
        setAllSlots([]);
        setLoading(false);
        return;
      }

      // Fetch trainer names
      const { data: trainerProfiles } = await supabase
        .from('trainer_profiles' as any)
        .select('id, user_id')
        .in('id', trainerIds);

      const userIds = (trainerProfiles || []).map((tp: any) => tp.user_id).filter(Boolean);
      let nameMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles' as any)
          .select('user_id, full_name')
          .in('user_id', userIds);
        (profiles || []).forEach((p: any) => {
          if (p.full_name) nameMap[p.user_id] = p.full_name;
        });
      }
      const trainerNameMap: Record<string, string> = {};
      (trainerProfiles || []).forEach((tp: any) => {
        trainerNameMap[tp.id] = nameMap[tp.user_id] || 'Unknown';
      });

      const { data: slots, error } = await supabase
        .from('availability_slots')
        .select(`
          id, start_time, end_time, max_participants,
          cyclus_id, cyclus_name, is_public,
          price_per_session, trainer_id,
          location_id, locations:location_id(name)
        `)
        .in('trainer_id', trainerIds)
        
        .gte('start_time', new Date().toISOString())
        .order('start_time', { ascending: true });

      if (error) throw error;

      const slotIds = slots?.map(s => s.id) || [];
      let bookingCounts: Record<string, number> = {};
      if (slotIds.length > 0) {
        const { data: bookings } = await supabase
          .from('bookings')
          .select('slot_id')
          .in('slot_id', slotIds)
          .in('status', ['confirmed', 'pending']);
        bookings?.forEach(b => {
          bookingCounts[b.slot_id] = (bookingCounts[b.slot_id] || 0) + 1;
        });
      }

      const processed: FlatSlot[] = (slots || []).map(slot => {
        const maxP = slot.max_participants || 4;
        const booked = bookingCounts[slot.id] || 0;
        return {
          id: slot.id,
          start_time: slot.start_time,
          end_time: slot.end_time,
          max_participants: maxP,
          booked_count: booked,
          available_spots: maxP - booked,
          cyclus_id: slot.cyclus_id,
          cyclus_name: slot.cyclus_name,
          is_public: slot.is_public ?? true,
          location_name: (slot.locations as any)?.name || null,
          location_id: slot.location_id,
          trainer_id: slot.trainer_id,
          trainer_name: trainerNameMap[slot.trainer_id] || null,
          price_per_session: slot.price_per_session,
        };
      }).filter(s => s.available_spots > 0);

      setAllSlots(processed);
      setSelectedIds(new Set());
    } catch (error) {
      logger.error('Error fetching academy open slots', error as Error, { component: 'AcademyOpenSlots' });
    } finally {
      setLoading(false);
    }
  };

  // Derive filter options
  const trainerOptions = useMemo(() => {
    const map = new Map<string, string>();
    allSlots.forEach(s => { if (s.trainer_id && s.trainer_name) map.set(s.trainer_id, s.trainer_name); });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allSlots]);

  const locationOptions = useMemo(() => {
    const map = new Map<string, string>();
    allSlots.forEach(s => { if (s.location_id && s.location_name) map.set(s.location_id, s.location_name); });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allSlots]);

  const cyclusOptions = useMemo(() => {
    const map = new Map<string, string>();
    allSlots.forEach(s => { if (s.cyclus_id && s.cyclus_name) map.set(s.cyclus_id, s.cyclus_name); });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allSlots]);

  // Apply filters
  const filteredSlots = useMemo(() => {
    return allSlots.filter(s => {
      if (filterTrainer !== 'all' && s.trainer_id !== filterTrainer) return false;
      if (filterLocation !== 'all' && s.location_id !== filterLocation) return false;
      if (filterCyclus !== 'all' && s.cyclus_id !== filterCyclus) return false;
      if (filterVisibility === 'public' && !s.is_public) return false;
      if (filterVisibility === 'hidden' && s.is_public) return false;
      return true;
    });
  }, [allSlots, filterTrainer, filterLocation, filterCyclus, filterVisibility]);

  const { sortedData, sortConfig, handleSort } = useTableSort<FlatSlot>(filteredSlots, 'start_time', 'asc');

  // Selection helpers
  const allSelected = sortedData.length > 0 && sortedData.every(s => selectedIds.has(s.id));
  const someSelected = selectedIds.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedData.map(s => s.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Inline visibility toggle
  const toggleSlotVisibility = useCallback(async (slotId: string, newValue: boolean) => {
    const { error } = await supabase
      .from('availability_slots')
      .update({ is_public: newValue })
      .eq('id', slotId);

    if (error) {
      logger.error('Error toggling slot visibility', error, { slotId });
      return;
    }
    setAllSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_public: newValue } : s));
  }, []);

  // Bulk visibility
  const handleBulkVisibility = useCallback(async (newValue: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkUpdating(true);

    const { error } = await supabase
      .from('availability_slots')
      .update({ is_public: newValue })
      .in('id', ids);

    if (error) {
      logger.error('Error bulk updating visibility', error);
      toast({ variant: 'destructive', description: 'Failed to update visibility' });
    } else {
      setAllSlots(prev => prev.map(s => ids.includes(s.id) ? { ...s, is_public: newValue } : s));
      toast({ description: `${ids.length} slots updated` });
      setSelectedIds(new Set());
    }
    setBulkUpdating(false);
  }, [selectedIds, toast]);

  // Bulk price
  const handleBulkPriceConfirm = useCallback(async () => {
    const price = parseFloat(bulkPrice);
    if (isNaN(price) || price < 0) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkUpdating(true);

    const { error } = await supabase
      .from('availability_slots')
      .update({ price_per_session: price })
      .in('id', ids);

    if (error) {
      logger.error('Error bulk updating price', error);
      toast({ variant: 'destructive', description: 'Failed to update prices' });
    } else {
      setAllSlots(prev => prev.map(s => ids.includes(s.id) ? { ...s, price_per_session: price } : s));
      toast({ description: `Price updated for ${ids.length} slots` });

      // Sync invoices in background
      syncInvoicesAfterPriceChange(ids).catch(err => {
        logger.error('Invoice sync after bulk price failed', err instanceof Error ? err : new Error(String(err)));
      });

      setSelectedIds(new Set());
    }
    setBulkUpdating(false);
    setPriceDialogOpen(false);
    setBulkPrice('');
  }, [selectedIds, bulkPrice, toast]);

  const formatSlotTime = (startStr: string, endStr: string) => {
    const start = new Date(startStr);
    const end = new Date(endStr);
    return {
      date: format(start, 'EEE d MMM', { locale: dateLocale }),
      time: format(start, 'HH:mm') + ' – ' + format(end, 'HH:mm'),
    };
  };

  return (
    <>
      {!embedded && (
        <div className="border-b bg-background/60">
          <div className="container mx-auto px-4 py-3">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/app/academy')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <h1 className="font-bold text-lg">{t('openSlots.title', 'Open Slots')}</h1>
              <Badge variant="secondary">{allSlots.length}</Badge>
            </div>
          </div>
        </div>
      )}

      <main className={embedded ? "" : "container mx-auto px-4 py-8"}>
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : allSlots.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Calendar className="h-16 w-16 text-muted-foreground mb-4" />
              <h2 className="text-xl font-semibold mb-2">
                {t('openSlots.noOpenSlots', 'No open slots available')}
              </h2>
              <p className="text-muted-foreground mb-6">
                {t('openSlots.noOpenSlotsDescription')}
              </p>
              <Button onClick={() => navigate('/app/academy/calendar')}>
                {t('openSlots.createSlots', 'Create new slots')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-3">
              <Select value={filterTrainer} onValueChange={setFilterTrainer}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t('openSlots.filterTrainer', 'Trainer')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common:all', 'All trainers')}</SelectItem>
                  {trainerOptions.map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={filterLocation} onValueChange={setFilterLocation}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t('openSlots.filterLocation', 'Location')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common:all', 'All locations')}</SelectItem>
                  {locationOptions.map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={filterCyclus} onValueChange={setFilterCyclus}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t('openSlots.filterCyclus', 'Cyclus')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common:all', 'All cycles')}</SelectItem>
                  {cyclusOptions.map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={filterVisibility} onValueChange={setFilterVisibility}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={t('openSlots.visibility', 'Visibility')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('common:all', 'All')}</SelectItem>
                  <SelectItem value="public">{t('openSlots.public', 'Public')}</SelectItem>
                  <SelectItem value="hidden">{t('openSlots.hidden', 'Hidden')}</SelectItem>
                </SelectContent>
              </Select>

              <div className="ml-auto text-sm text-muted-foreground self-center">
                {sortedData.length} {t('common:slots', 'slots')}
              </div>
            </div>

            {/* Bulk toolbar */}
            {someSelected && (
              <div className="sticky top-0 z-10 flex items-center gap-3 p-3 rounded-lg border bg-muted/80 backdrop-blur">
                <span className="text-sm font-medium">
                  {selectedIds.size} {t('openSlots.selected', 'selected')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPriceDialogOpen(true)}
                  disabled={bulkUpdating}
                >
                  <Euro className="h-4 w-4 mr-1" />
                  {t('openSlots.setPrice', 'Set price')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleBulkVisibility(true)}
                  disabled={bulkUpdating}
                >
                  <Eye className="h-4 w-4 mr-1" />
                  {t('openSlots.makePublic', 'Make public')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleBulkVisibility(false)}
                  disabled={bulkUpdating}
                >
                  <EyeOff className="h-4 w-4 mr-1" />
                  {t('openSlots.makeHidden', 'Hide')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedIds(new Set())}
                >
                  <X className="h-4 w-4 mr-1" />
                  {t('common:deselectAll', 'Deselect')}
                </Button>
              </div>
            )}

            {/* Table */}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <SortableTableHead
                      sortKey="start_time"
                      currentSortKey={sortConfig.key as string | null}
                      currentDirection={sortConfig.direction}
                      onSort={(k) => handleSort(k as keyof FlatSlot)}
                    >
                      {t('openSlots.dateTime', 'Date / Time')}
                    </SortableTableHead>
                    <SortableTableHead
                      sortKey="cyclus_name"
                      currentSortKey={sortConfig.key as string | null}
                      currentDirection={sortConfig.direction}
                      onSort={(k) => handleSort(k as keyof FlatSlot)}
                    >
                      {t('openSlots.cyclus', 'Cyclus')}
                    </SortableTableHead>
                    <SortableTableHead
                      sortKey="trainer_name"
                      currentSortKey={sortConfig.key as string | null}
                      currentDirection={sortConfig.direction}
                      onSort={(k) => handleSort(k as keyof FlatSlot)}
                    >
                      {t('openSlots.trainer', 'Trainer')}
                    </SortableTableHead>
                    <SortableTableHead
                      sortKey="location_name"
                      currentSortKey={sortConfig.key as string | null}
                      currentDirection={sortConfig.direction}
                      onSort={(k) => handleSort(k as keyof FlatSlot)}
                    >
                      {t('openSlots.location', 'Location')}
                    </SortableTableHead>
                    <SortableTableHead
                      sortKey="available_spots"
                      currentSortKey={sortConfig.key as string | null}
                      currentDirection={sortConfig.direction}
                      onSort={(k) => handleSort(k as keyof FlatSlot)}
                    >
                      {t('openSlots.spots', 'Spots')}
                    </SortableTableHead>
                    <SortableTableHead
                      sortKey="price_per_session"
                      currentSortKey={sortConfig.key as string | null}
                      currentDirection={sortConfig.direction}
                      onSort={(k) => handleSort(k as keyof FlatSlot)}
                    >
                      {t('openSlots.price', 'Price')}
                    </SortableTableHead>
                    <TableHead className="w-[80px]">
                      {t('openSlots.public', 'Public')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        {t('openSlots.noMatchingSlots', 'No slots match current filters')}
                      </TableCell>
                    </TableRow>
                  ) : (
                    sortedData.map(slot => {
                      const { date, time } = formatSlotTime(slot.start_time, slot.end_time);
                      return (
                        <TableRow
                          key={slot.id}
                          className="cursor-pointer"
                          onClick={() => navigate(`/app/academy/slot/${slot.id}`)}
                        >
                          <TableCell onClick={e => e.stopPropagation()}>
                            <Checkbox
                              checked={selectedIds.has(slot.id)}
                              onCheckedChange={() => toggleSelect(slot.id)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-sm">{date}</div>
                            <div className="text-xs text-muted-foreground">{time}</div>
                          </TableCell>
                          <TableCell>
                            {slot.cyclus_name ? (
                              <Badge variant="outline" className="text-xs">{slot.cyclus_name}</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{slot.trainer_name || '—'}</TableCell>
                          <TableCell>
                            {slot.location_name ? (
                              <span className="flex items-center gap-1 text-sm">
                                <MapPin className="h-3 w-3 text-muted-foreground" />
                                {slot.location_name}
                              </span>
                            ) : '—'}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm">
                              {slot.available_spots}/{slot.max_participants}
                            </span>
                          </TableCell>
                          <TableCell className="text-sm">
                            {slot.price_per_session != null ? formatPrice(slot.price_per_session) : '—'}
                          </TableCell>
                          <TableCell onClick={e => e.stopPropagation()}>
                            <Switch
                              checked={slot.is_public}
                              onCheckedChange={(val) => toggleSlotVisibility(slot.id, val)}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </main>

      {/* Bulk price dialog */}
      <Dialog open={priceDialogOpen} onOpenChange={setPriceDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('openSlots.setPriceTitle', 'Set price per session')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t('openSlots.setPriceDescription', 'This will update the price for {{count}} selected slots and recalculate any unpaid invoices.', { count: selectedIds.size })}
            </p>
            <div className="space-y-2">
              <Label>{t('openSlots.pricePerSession', 'Price per session (€)')}</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={bulkPrice}
                onChange={e => setBulkPrice(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceDialogOpen(false)}>
              {t('common:cancel', 'Cancel')}
            </Button>
            <Button
              onClick={handleBulkPriceConfirm}
              disabled={bulkUpdating || !bulkPrice || isNaN(parseFloat(bulkPrice))}
            >
              {bulkUpdating ? t('common:saving', 'Saving...') : t('openSlots.updatePrice', 'Update price')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
