// Shared availability-slot view types.
//
// These describe a slot + the players booked into it, as rendered by the
// calendar/agenda surfaces across MULTIPLE roles (trainer, academy, club). They
// live in lib/ (role-neutral) rather than in any one role's component folder so
// every role can import them without crossing a role boundary. See
// docs/FRONTEND_ARCHITECTURE.md.

export interface BookedPlayer {
  id: string;
  bookingId: string;
  name: string;
  status: "confirmed" | "pending";
  isGuest: boolean;
  skillRating?: number | null;
  ratingSystem?: string;
  paymentStatus?: string;
  paidExternally?: boolean;
  birthDate?: string | null;
}

export interface SlotWithBookings {
  id: string;
  start_time: string;
  end_time: string;
  max_participants: number;
  price: number | null;
  active_bookings: number;
  pending_bookings: number;
  is_past: boolean;
  is_public: boolean;
  cyclus_id: string | null;
  cyclus_name: string | null;
  booked_players: BookedPlayer[];
  location_name: string | null;
  trainer_id?: string;
  trainer_name?: string;
  trainer_avatar?: string;
  rating_system?: string | null;
  min_rating?: number | null;
  max_rating?: number | null;
}
