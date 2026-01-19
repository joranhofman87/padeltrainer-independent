export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      availability_slots: {
        Row: {
          created_at: string
          cyclus_id: string | null
          cyclus_name: string | null
          end_time: string
          id: string
          is_marked_full: boolean
          is_recurring: boolean
          lesson_id: string | null
          recurrence_rule: string | null
          start_time: string
          trainer_id: string
        }
        Insert: {
          created_at?: string
          cyclus_id?: string | null
          cyclus_name?: string | null
          end_time: string
          id?: string
          is_marked_full?: boolean
          is_recurring?: boolean
          lesson_id?: string | null
          recurrence_rule?: string | null
          start_time: string
          trainer_id: string
        }
        Update: {
          created_at?: string
          cyclus_id?: string | null
          cyclus_name?: string | null
          end_time?: string
          id?: string
          is_marked_full?: boolean
          is_recurring?: boolean
          lesson_id?: string | null
          recurrence_rule?: string | null
          start_time?: string
          trainer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_slots_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          created_at: string
          guest_player_id: string | null
          id: string
          lesson_id: string | null
          notes: string | null
          paid_at: string | null
          payment_amount: number | null
          payment_status: string
          player_id: string | null
          slot_id: string
          status: string
          stripe_payment_intent_id: string | null
          stripe_session_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          guest_player_id?: string | null
          id?: string
          lesson_id?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_amount?: number | null
          payment_status?: string
          player_id?: string | null
          slot_id: string
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          guest_player_id?: string | null
          id?: string
          lesson_id?: string | null
          notes?: string | null
          paid_at?: string | null
          payment_amount?: number | null
          payment_status?: string
          player_id?: string | null
          slot_id?: string
          status?: string
          stripe_payment_intent_id?: string | null
          stripe_session_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bookings_guest_player_id_fkey"
            columns: ["guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_events: {
        Row: {
          booking_id: string
          created_at: string
          google_event_id: string
          id: string
          user_id: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          google_event_id: string
          id?: string
          user_id: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          google_event_id?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      guest_players: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          linked_profile_id: string | null
          notes: string | null
          phone: string
          rating_system: string
          skill_rating: number | null
          trainer_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id?: string
          linked_profile_id?: string | null
          notes?: string | null
          phone: string
          rating_system?: string
          skill_rating?: number | null
          trainer_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string
          rating_system?: string
          skill_rating?: number | null
          trainer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_players_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          booking_ids: string[] | null
          created_at: string
          due_date: string
          guest_player_id: string | null
          id: string
          invoice_date: string
          invoice_number: string
          line_items: Json
          notes: string | null
          paid_at: string | null
          pdf_url: string | null
          player_address: string | null
          player_btw_number: string | null
          player_id: string | null
          player_name: string
          sent_at: string | null
          status: string
          subtotal: number
          total: number
          trainer_id: string
          updated_at: string
          vat_amount: number
          vat_rate: number
        }
        Insert: {
          booking_ids?: string[] | null
          created_at?: string
          due_date: string
          guest_player_id?: string | null
          id?: string
          invoice_date?: string
          invoice_number: string
          line_items?: Json
          notes?: string | null
          paid_at?: string | null
          pdf_url?: string | null
          player_address?: string | null
          player_btw_number?: string | null
          player_id?: string | null
          player_name: string
          sent_at?: string | null
          status?: string
          subtotal?: number
          total?: number
          trainer_id: string
          updated_at?: string
          vat_amount?: number
          vat_rate?: number
        }
        Update: {
          booking_ids?: string[] | null
          created_at?: string
          due_date?: string
          guest_player_id?: string | null
          id?: string
          invoice_date?: string
          invoice_number?: string
          line_items?: Json
          notes?: string | null
          paid_at?: string | null
          pdf_url?: string | null
          player_address?: string | null
          player_btw_number?: string | null
          player_id?: string | null
          player_name?: string
          sent_at?: string | null
          status?: string
          subtotal?: number
          total?: number
          trainer_id?: string
          updated_at?: string
          vat_amount?: number
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_guest_player_id_fkey"
            columns: ["guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lessons: {
        Row: {
          created_at: string
          description: string | null
          duration_minutes: number
          id: string
          is_active: boolean
          is_recurring: boolean
          location: string | null
          max_participants: number
          max_skill_rating: number | null
          min_skill_rating: number | null
          payment_timing: string
          price: number
          recurrence_count: number | null
          recurrence_day: number | null
          recurrence_end_date: string | null
          recurrence_time: string | null
          recurrence_type: string | null
          start_date: string | null
          title: string
          trainer_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          duration_minutes?: number
          id?: string
          is_active?: boolean
          is_recurring?: boolean
          location?: string | null
          max_participants?: number
          max_skill_rating?: number | null
          min_skill_rating?: number | null
          payment_timing?: string
          price: number
          recurrence_count?: number | null
          recurrence_day?: number | null
          recurrence_end_date?: string | null
          recurrence_time?: string | null
          recurrence_type?: string | null
          start_date?: string | null
          title: string
          trainer_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          duration_minutes?: number
          id?: string
          is_active?: boolean
          is_recurring?: boolean
          location?: string | null
          max_participants?: number
          max_skill_rating?: number | null
          min_skill_rating?: number | null
          payment_timing?: string
          price?: number
          recurrence_count?: number | null
          recurrence_day?: number | null
          recurrence_end_date?: string | null
          recurrence_time?: string | null
          recurrence_type?: string | null
          start_date?: string | null
          title?: string
          trainer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lessons_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          city: string
          country: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          postal_code: string | null
          slug: string
          street_address: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          city: string
          country?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          postal_code?: string | null
          slug: string
          street_address?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          city?: string
          country?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          postal_code?: string | null
          slug?: string
          street_address?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: []
      }
      notification_preferences: {
        Row: {
          created_at: string
          email_booking_confirmation: boolean
          email_booking_reminder: boolean
          email_new_availability: boolean
          email_review_received: boolean
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email_booking_confirmation?: boolean
          email_booking_reminder?: boolean
          email_new_availability?: boolean
          email_review_received?: boolean
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email_booking_confirmation?: boolean
          email_booking_reminder?: boolean
          email_new_availability?: boolean
          email_review_received?: boolean
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      player_locations: {
        Row: {
          created_at: string
          id: string
          is_preferred: boolean
          location_id: string
          profile_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_preferred?: boolean
          location_id: string
          profile_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_preferred?: boolean
          location_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      player_rating_history: {
        Row: {
          created_at: string
          id: string
          profile_id: string
          rating: number
          rating_system: string
          scraped_at: string
          source: string
        }
        Insert: {
          created_at?: string
          id?: string
          profile_id: string
          rating: number
          rating_system?: string
          scraped_at?: string
          source?: string
        }
        Update: {
          created_at?: string
          id?: string
          profile_id?: string
          rating?: number
          rating_system?: string
          scraped_at?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_rating_history_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_rating_history_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          knltb_number: string | null
          location: string | null
          phone: string | null
          rating_system: string
          skill_rating: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          knltb_number?: string | null
          location?: string | null
          phone?: string | null
          rating_system?: string
          skill_rating?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          knltb_number?: string | null
          location?: string | null
          phone?: string | null
          rating_system?: string
          skill_rating?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          booking_id: string
          comment: string | null
          created_at: string
          id: string
          is_public: boolean
          player_id: string
          rating: number
          trainer_id: string
          updated_at: string
        }
        Insert: {
          booking_id: string
          comment?: string | null
          created_at?: string
          id?: string
          is_public?: boolean
          player_id: string
          rating: number
          trainer_id: string
          updated_at?: string
        }
        Update: {
          booking_id?: string
          comment?: string | null
          created_at?: string
          id?: string
          is_public?: boolean
          player_id?: string
          rating?: number
          trainer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_followers: {
        Row: {
          created_at: string
          id: string
          notify_new_availability: boolean
          player_id: string
          trainer_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notify_new_availability?: boolean
          player_id: string
          trainer_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notify_new_availability?: boolean
          player_id?: string
          trainer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_followers_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_locations: {
        Row: {
          created_at: string
          id: string
          is_primary: boolean
          location_id: string
          trainer_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_primary?: boolean
          location_id: string
          trainer_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_primary?: boolean
          location_id?: string
          trainer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_locations_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_profile_views: {
        Row: {
          id: string
          session_id: string | null
          trainer_id: string
          viewed_at: string
        }
        Insert: {
          id?: string
          session_id?: string | null
          trainer_id: string
          viewed_at?: string
        }
        Update: {
          id?: string
          session_id?: string | null
          trainer_id?: string
          viewed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_profile_views_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_profiles: {
        Row: {
          bic: string | null
          btw_number: string | null
          business_address: string | null
          business_name: string | null
          certifications: string[] | null
          created_at: string
          experience_years: number | null
          hourly_rate: number | null
          iban: string | null
          id: string
          is_verified: boolean | null
          knltb_rating: number | null
          kvk_number: string | null
          payment_terms_days: number | null
          require_booking_approval: boolean | null
          schedule_weeks_ahead: number
          slot_duration_minutes: number
          slot_gap_minutes: number
          specializations: string[] | null
          stripe_account_id: string | null
          subscription_status: string | null
          updated_at: string
          use_manual_invoicing: boolean | null
          user_id: string
        }
        Insert: {
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          certifications?: string[] | null
          created_at?: string
          experience_years?: number | null
          hourly_rate?: number | null
          iban?: string | null
          id?: string
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          payment_terms_days?: number | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number
          slot_duration_minutes?: number
          slot_gap_minutes?: number
          specializations?: string[] | null
          stripe_account_id?: string | null
          subscription_status?: string | null
          updated_at?: string
          use_manual_invoicing?: boolean | null
          user_id: string
        }
        Update: {
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          certifications?: string[] | null
          created_at?: string
          experience_years?: number | null
          hourly_rate?: number | null
          iban?: string | null
          id?: string
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          payment_terms_days?: number | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number
          slot_duration_minutes?: number
          slot_gap_minutes?: number
          specializations?: string[] | null
          stripe_account_id?: string | null
          subscription_status?: string | null
          updated_at?: string
          use_manual_invoicing?: boolean | null
          user_id?: string
        }
        Relationships: []
      }
      trainer_stripe_accounts: {
        Row: {
          charges_enabled: boolean
          created_at: string
          id: string
          onboarding_complete: boolean
          payouts_enabled: boolean
          stripe_account_id: string
          trainer_id: string
          updated_at: string
        }
        Insert: {
          charges_enabled?: boolean
          created_at?: string
          id?: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          stripe_account_id: string
          trainer_id: string
          updated_at?: string
        }
        Update: {
          charges_enabled?: boolean
          created_at?: string
          id?: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          stripe_account_id?: string
          trainer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_stripe_accounts_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_working_hours: {
        Row: {
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          is_active: boolean
          start_time: string
          trainer_id: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          end_time: string
          id?: string
          is_active?: boolean
          start_time: string
          trainer_id: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          is_active?: boolean
          start_time?: string
          trainer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_working_hours_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_calendar_connections: {
        Row: {
          access_token: string
          calendar_id: string | null
          created_at: string
          id: string
          is_active: boolean
          provider: string
          refresh_token: string | null
          token_expires_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token: string
          calendar_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          provider?: string
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string
          calendar_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          provider?: string
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      profiles_public: {
        Row: {
          avatar_url: string | null
          bio: string | null
          created_at: string | null
          full_name: string | null
          id: string | null
          knltb_number: string | null
          location: string | null
          rating_system: string | null
          skill_rating: number | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string | null
          full_name?: string | null
          id?: string | null
          knltb_number?: string | null
          location?: string | null
          rating_system?: string | null
          skill_rating?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          created_at?: string | null
          full_name?: string | null
          id?: string | null
          knltb_number?: string | null
          location?: string | null
          rating_system?: string | null
          skill_rating?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      generate_location_slug: {
        Args: { city: string; name: string }
        Returns: string
      }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_player: { Args: { _user_id: string }; Returns: boolean }
      is_trainer: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "player" | "trainer" | "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["player", "trainer", "admin"],
    },
  },
} as const
