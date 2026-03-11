import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Calendar, Clock, Euro, MapPin, Minus, Plus, Repeat, Users } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { formatPrice } from '@/lib/pricing';
import TermsAcceptance from '@/components/booking/TermsAcceptance';

interface SlotWithDetails {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  price_per_session?: number | null;
  max_participants?: number | null;
  allow_single_booking?: boolean | null;
  spotsLeft?: number;
  location?: { id: string; name: string; city: string; street_address: string | null } | null;
}

interface CyclusBundle {
  cyclus_id: string;
  cyclus_name: string;
  slots: Array<{ id: string; start_time: string; end_time: string; price_per_session?: number | null }>;
  totalPrice: number;
  firstDate: string;
  lastDate: string;
  location?: { id: string; name: string; city: string; street_address: string | null } | null;
}

interface BookingSummaryProps {
  selectedSlot: SlotWithDetails | null;
  selectedCyclus: CyclusBundle | null;
  notes: string;
  onNotesChange: (notes: string) => void;
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  applicableTerms: string | null;
  termsLoading: boolean;
  termsAccepted: boolean;
  onTermsAcceptChange: (accepted: boolean) => void;
  booking: boolean;
  onBook: () => void;
  user: unknown;
  trainerId: string;
  getSlotPrice: (slot: SlotWithDetails) => number;
  cycleSettingsMap: Record<string, { min_group_size?: number }>;
}

export function BookingSummary({
  selectedSlot,
  selectedCyclus,
  notes,
  onNotesChange,
  quantity,
  onQuantityChange,
  applicableTerms,
  termsLoading,
  termsAccepted,
  onTermsAcceptChange,
  booking,
  onBook,
  user,
  trainerId,
  getSlotPrice,
  cycleSettingsMap,
}: BookingSummaryProps) {
  const navigate = useNavigate();

  return (
    <div className="lg:sticky lg:top-24 h-fit">
      <Card>
        <CardHeader>
          <CardTitle>Booking Summary</CardTitle>
          <CardDescription>Review your lesson booking</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {selectedCyclus ? (
            <>
              <div className="p-4 bg-muted rounded-lg space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <Repeat className="h-4 w-4 text-primary" />
                  <p className="font-semibold">{selectedCyclus.cyclus_name}</p>
                </div>
                <Badge variant="secondary" className="mb-2">
                  {selectedCyclus.slots.length} sessions
                </Badge>
                <div className="text-sm text-muted-foreground space-y-1 mt-2 max-h-32 overflow-y-auto">
                  {selectedCyclus.slots.map((slot) => (
                    <p key={slot.id} className="flex items-center gap-2">
                      <Calendar className="h-3 w-3" />
                      {format(parseISO(slot.start_time), 'EEE, MMM d')} at {format(parseISO(slot.start_time), 'HH:mm')}
                    </p>
                  ))}
                </div>
                {selectedCyclus.location && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                    <MapPin className="h-4 w-4" />
                    {selectedCyclus.location.name}, {selectedCyclus.location.city}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Notes for trainer (optional)</Label>
                <Textarea
                  id="notes"
                  placeholder="Any special requests or information..."
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                />
              </div>

              <TermsAcceptance
                terms={applicableTerms}
                loading={termsLoading}
                accepted={termsAccepted}
                onAcceptChange={onTermsAcceptChange}
              />

              <div className="border-t pt-4">
                <div className="flex justify-between items-center text-lg font-semibold">
                  <span>Total ({selectedCyclus.slots.length} sessions)</span>
                  <span>{formatPrice(selectedCyclus.totalPrice)}</span>
                </div>
              </div>

              {!user ? (
                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => navigate(`/app/signup/player?redirect=/app/book/${trainerId}`)}
                >
                  Sign Up to Book
                </Button>
              ) : (
                <Button
                  className="w-full"
                  size="lg"
                  onClick={onBook}
                  disabled={booking || (!!applicableTerms && !termsAccepted)}
                >
                  {booking ? 'Booking...' : `Book Entire Cycle (${selectedCyclus.slots.length} sessions)`}
                </Button>
              )}
            </>
          ) : selectedSlot ? (
            <>
              <div className="p-4 bg-muted rounded-lg space-y-2">
                <p className="font-semibold">
                  {selectedSlot.cyclus_name || 'Training Session'}
                </p>
                <div className="text-sm text-muted-foreground space-y-1">
                  <p className="flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    {format(parseISO(selectedSlot.start_time), 'EEEE, MMMM d, yyyy')}
                  </p>
                  <p className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    {format(parseISO(selectedSlot.start_time), 'HH:mm')} -{' '}
                    {format(parseISO(selectedSlot.end_time), 'HH:mm')}
                  </p>
                  {selectedSlot.location && (
                    <p className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      {selectedSlot.location.name}, {selectedSlot.location.city}
                    </p>
                  )}
                </div>
              </div>

              {/* Quantity picker for allow_single_booking */}
              {(() => {
                const maxP = selectedSlot.max_participants || 1;
                const spotsAvailable = selectedSlot.spotsLeft || maxP;
                const slotPrice = getSlotPrice(selectedSlot);
                const perSpot = maxP > 1 && selectedSlot.allow_single_booking ? slotPrice / maxP : 0;
                const minGroup = selectedSlot.cyclus_id ? (cycleSettingsMap[selectedSlot.cyclus_id]?.min_group_size || 1) : 1;

                if (selectedSlot.allow_single_booking && maxP > 1) {
                  return (
                    <div className="space-y-2">
                      <Label>Number of spots</Label>
                      <div className="flex items-center gap-3">
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => onQuantityChange(Math.max(minGroup, quantity - 1))}
                          disabled={quantity <= minGroup}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <span className="font-semibold text-lg w-8 text-center">{quantity}</span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => onQuantityChange(Math.min(spotsAvailable, quantity + 1))}
                          disabled={quantity >= spotsAvailable}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          of {spotsAvailable} available
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatPrice(perSpot)} per spot
                      </p>
                      {minGroup > 1 && (
                        <div className="p-2 bg-amber-50 dark:bg-amber-950 rounded text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                          <Users className="h-3.5 w-3.5" />
                          This session requires a minimum of {minGroup} players
                        </div>
                      )}
                    </div>
                  );
                }
                return null;
              })()}

              <div className="space-y-2">
                <Label htmlFor="notes">Notes for trainer (optional)</Label>
                <Textarea
                  id="notes"
                  placeholder="Any special requests or information..."
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                />
              </div>

              <TermsAcceptance
                terms={applicableTerms}
                loading={termsLoading}
                accepted={termsAccepted}
                onAcceptChange={onTermsAcceptChange}
              />

              <div className="border-t pt-4">
                <div className="flex justify-between items-center text-lg font-semibold">
                  <span>Total</span>
                  <span>
                    {(() => {
                      const maxP = selectedSlot.max_participants || 1;
                      const slotPrice = getSlotPrice(selectedSlot);
                      if (!selectedSlot.allow_single_booking || maxP <= 1) return formatPrice(slotPrice);
                      const perSpot = slotPrice / maxP;
                      return formatPrice(perSpot * quantity);
                    })()}
                  </span>
                </div>
              </div>

              {!user ? (
                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => navigate(`/app/signup/player?redirect=/app/book/${trainerId}`)}
                >
                  Sign Up to Book
                </Button>
              ) : (
                <Button
                  className="w-full"
                  size="lg"
                  onClick={onBook}
                  disabled={booking || (!!applicableTerms && !termsAccepted)}
                >
                  {booking ? 'Booking...' : 'Confirm Booking'}
                </Button>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-center py-8">
              Select a time slot or training cycle to continue
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
