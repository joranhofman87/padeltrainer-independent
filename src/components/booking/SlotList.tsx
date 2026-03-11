import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, Check, Clock, Euro, MapPin, Users } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { formatPrice } from '@/lib/pricing';

interface SlotWithDetails {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  court_type?: 'indoor' | 'outdoor' | null;
  price_per_session?: number | null;
  max_participants?: number | null;
  allow_single_booking?: boolean | null;
  averageRating?: number | null;
  ratingSystem?: string;
  spotsLeft?: number;
  location?: { id: string; name: string; city: string; street_address: string | null } | null;
  rating_system?: string | null;
  min_rating?: number | null;
  max_rating?: number | null;
}

interface SlotListProps {
  slots: SlotWithDetails[];
  selectedSlotId: string | null;
  hasCycles: boolean;
  getSlotPrice: (slot: SlotWithDetails) => number;
  onSelect: (slot: SlotWithDetails) => void;
}

export function SlotList({ slots, selectedSlotId, hasCycles, getSlotPrice, onSelect }: SlotListProps) {
  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">
        {hasCycles ? 'Individual Sessions' : 'Available Time Slots'}
      </h3>
      {slots.length === 0 && !hasCycles ? (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">No available slots at the moment</p>
        </Card>
      ) : slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No individual sessions available</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {slots.map((slot) => {
            const slotPrice = getSlotPrice(slot);

            return (
              <Card
                key={slot.id}
                className={`transition-all ${
                  selectedSlotId === slot.id
                    ? 'ring-2 ring-primary border-primary cursor-pointer'
                    : 'hover:border-primary/50 cursor-pointer'
                }`}
                onClick={() => onSelect(slot)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">
                        {format(parseISO(slot.start_time), 'EEE, MMM d')}
                      </span>
                    </div>
                    {selectedSlotId === slot.id && (
                      <Check className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                    <Clock className="h-4 w-4" />
                    {format(parseISO(slot.start_time), 'HH:mm')} -{' '}
                    {format(parseISO(slot.end_time), 'HH:mm')}
                  </div>
                  {slot.location && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <MapPin className="h-3 w-3" />
                      {slot.location.name}, {slot.location.city}
                    </p>
                  )}
                  {slot.court_type && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      {slot.court_type === 'indoor' ? '🏠' : '☀️'}{' '}
                      {slot.court_type === 'indoor' ? 'Indoor' : 'Outdoor'}
                    </p>
                  )}
                  {slotPrice > 0 && (
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t">
                      <Euro className="h-4 w-4 text-primary" />
                      <span className="font-semibold text-primary">
                        {slot.allow_single_booking && (slot.max_participants || 1) > 1
                          ? `${formatPrice(slotPrice / (slot.max_participants || 1))}/spot`
                          : formatPrice(slotPrice)}
                      </span>
                    </div>
                  )}

                  {/* Spots left and Average Level */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t">
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Users className="h-4 w-4" />
                      <span>{slot.spotsLeft || (slot.max_participants || 4)}/{slot.max_participants || 4} spots left</span>
                    </div>
                    {slot.averageRating !== null && slot.averageRating !== undefined && (
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-xs">
                          Avg: {slot.averageRating.toFixed(1)}
                        </Badge>
                        <span className="text-xs text-muted-foreground uppercase">
                          {slot.ratingSystem || 'knltb'}
                        </span>
                      </div>
                    )}
                    {slot.rating_system && (
                      <Badge variant="outline" className="text-xs gap-1">
                        {slot.rating_system.toUpperCase()}
                        {slot.min_rating != null && slot.max_rating != null
                          ? ` ${slot.min_rating}–${slot.max_rating}`
                          : slot.min_rating != null
                          ? ` ≥${slot.min_rating}`
                          : slot.max_rating != null
                          ? ` ≤${slot.max_rating}`
                          : ''}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
