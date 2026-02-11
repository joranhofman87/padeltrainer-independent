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
      academy_followers: {
        Row: {
          academy_profile_id: string
          created_at: string
          id: string
          notify_new_availability: boolean
          player_id: string
        }
        Insert: {
          academy_profile_id: string
          created_at?: string
          id?: string
          notify_new_availability?: boolean
          player_id: string
        }
        Update: {
          academy_profile_id?: string
          created_at?: string
          id?: string
          notify_new_availability?: boolean
          player_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_followers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_followers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_followers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_locations: {
        Row: {
          academy_profile_id: string
          contract_end: string | null
          contract_start: string | null
          contract_type: string | null
          created_at: string
          id: string
          is_active: boolean
          location_id: string
          show_on_academy_page: boolean
          show_on_club_page: boolean
        }
        Insert: {
          academy_profile_id: string
          contract_end?: string | null
          contract_start?: string | null
          contract_type?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          location_id: string
          show_on_academy_page?: boolean
          show_on_club_page?: boolean
        }
        Update: {
          academy_profile_id?: string
          contract_end?: string | null
          contract_start?: string | null
          contract_type?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          location_id?: string
          show_on_academy_page?: boolean
          show_on_club_page?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "academy_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_managers: {
        Row: {
          academy_profile_id: string
          created_at: string
          id: string
          invited_by: string | null
          role: string
          user_id: string
        }
        Insert: {
          academy_profile_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          user_id: string
        }
        Update: {
          academy_profile_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_managers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_managers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_managers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_mollie_accounts: {
        Row: {
          academy_profile_id: string
          access_token: string | null
          charges_enabled: boolean
          created_at: string
          id: string
          mollie_organization_id: string
          onboarding_complete: boolean
          payouts_enabled: boolean
          refresh_token: string | null
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id: string
          access_token?: string | null
          charges_enabled?: boolean
          created_at?: string
          id?: string
          mollie_organization_id: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string
          access_token?: string | null
          charges_enabled?: boolean
          created_at?: string
          id?: string
          mollie_organization_id?: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: true
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: true
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: true
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_profile_views: {
        Row: {
          academy_profile_id: string
          id: string
          session_id: string | null
          viewed_at: string
        }
        Insert: {
          academy_profile_id: string
          id?: string
          session_id?: string | null
          viewed_at?: string
        }
        Update: {
          academy_profile_id?: string
          id?: string
          session_id?: string | null
          viewed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_profile_views_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_profile_views_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_profile_views_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_profiles: {
        Row: {
          banner_url: string | null
          contact_email: string | null
          country: string
          created_at: string
          created_by: string | null
          description: string | null
          general_terms: string | null
          id: string
          is_public: boolean
          is_verified: boolean
          logo_url: string | null
          mollie_customer_id: string | null
          name: string
          phone: string | null
          platform_fee_override: number | null
          slug: string
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          trial_ends_at: string | null
          updated_at: string
          waiting_list_enabled: boolean
          website_url: string | null
        }
        Insert: {
          banner_url?: string | null
          contact_email?: string | null
          country?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          general_terms?: string | null
          id?: string
          is_public?: boolean
          is_verified?: boolean
          logo_url?: string | null
          mollie_customer_id?: string | null
          name: string
          phone?: string | null
          platform_fee_override?: number | null
          slug: string
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          waiting_list_enabled?: boolean
          website_url?: string | null
        }
        Update: {
          banner_url?: string | null
          contact_email?: string | null
          country?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          general_terms?: string | null
          id?: string
          is_public?: boolean
          is_verified?: boolean
          logo_url?: string | null
          mollie_customer_id?: string | null
          name?: string
          phone?: string | null
          platform_fee_override?: number | null
          slug?: string
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          waiting_list_enabled?: boolean
          website_url?: string | null
        }
        Relationships: []
      }
      academy_trainer_invitations: {
        Row: {
          academy_profile_id: string
          created_at: string
          id: string
          invited_by: string
          message: string | null
          payment_percentage: number
          responded_at: string | null
          status: string
          token: string
          trainer_email: string
          trainer_profile_id: string | null
        }
        Insert: {
          academy_profile_id: string
          created_at?: string
          id?: string
          invited_by: string
          message?: string | null
          payment_percentage?: number
          responded_at?: string | null
          status?: string
          token?: string
          trainer_email: string
          trainer_profile_id?: string | null
        }
        Update: {
          academy_profile_id?: string
          created_at?: string
          id?: string
          invited_by?: string
          message?: string | null
          payment_percentage?: number
          responded_at?: string | null
          status?: string
          token?: string
          trainer_email?: string
          trainer_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "academy_trainer_invitations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainer_invitations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainer_invitations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainer_invitations_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainer_invitations_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_trainers: {
        Row: {
          academy_profile_id: string
          created_at: string
          id: string
          invited_by: string | null
          joined_at: string | null
          payment_percentage: number
          show_on_academy_page: boolean
          status: string
          trainer_profile_id: string
          updated_at: string
        }
        Insert: {
          academy_profile_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          joined_at?: string | null
          payment_percentage?: number
          show_on_academy_page?: boolean
          status?: string
          trainer_profile_id: string
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          joined_at?: string | null
          payment_percentage?: number
          show_on_academy_page?: boolean
          status?: string
          trainer_profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_trainers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainers_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainers_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_trainers_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_impersonation_logs: {
        Row: {
          action: string | null
          admin_user_id: string
          created_at: string
          details: Json | null
          ended_at: string | null
          expires_at: string
          id: string
          ip_address: string | null
          target_user_id: string
          user_agent: string | null
        }
        Insert: {
          action?: string | null
          admin_user_id: string
          created_at?: string
          details?: Json | null
          ended_at?: string | null
          expires_at: string
          id?: string
          ip_address?: string | null
          target_user_id: string
          user_agent?: string | null
        }
        Update: {
          action?: string | null
          admin_user_id?: string
          created_at?: string
          details?: Json | null
          ended_at?: string | null
          expires_at?: string
          id?: string
          ip_address?: string | null
          target_user_id?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      availability_slots: {
        Row: {
          academy_profile_id: string | null
          allow_single_booking: boolean | null
          court_type: string | null
          created_at: string
          cyclus_id: string | null
          cyclus_name: string | null
          end_time: string
          extra_costs: Json | null
          id: string
          is_marked_full: boolean
          is_public: boolean
          is_recurring: boolean
          location_id: string | null
          max_participants: number | null
          min_participants: number | null
          price_per_session: number | null
          recurrence_rule: string | null
          start_time: string
          total_price: number | null
          trainer_id: string
          training_level: string | null
        }
        Insert: {
          academy_profile_id?: string | null
          allow_single_booking?: boolean | null
          court_type?: string | null
          created_at?: string
          cyclus_id?: string | null
          cyclus_name?: string | null
          end_time: string
          extra_costs?: Json | null
          id?: string
          is_marked_full?: boolean
          is_public?: boolean
          is_recurring?: boolean
          location_id?: string | null
          max_participants?: number | null
          min_participants?: number | null
          price_per_session?: number | null
          recurrence_rule?: string | null
          start_time: string
          total_price?: number | null
          trainer_id: string
          training_level?: string | null
        }
        Update: {
          academy_profile_id?: string | null
          allow_single_booking?: boolean | null
          court_type?: string | null
          created_at?: string
          cyclus_id?: string | null
          cyclus_name?: string | null
          end_time?: string
          extra_costs?: Json | null
          id?: string
          is_marked_full?: boolean
          is_public?: boolean
          is_recurring?: boolean
          location_id?: string | null
          max_participants?: number | null
          min_participants?: number | null
          price_per_session?: number | null
          recurrence_rule?: string | null
          start_time?: string
          total_price?: number | null
          trainer_id?: string
          training_level?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "availability_slots_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      bookings: {
        Row: {
          court_type: string | null
          created_at: string
          discount_amount: number | null
          discount_reason: string | null
          guest_player_id: string | null
          id: string
          mollie_payment_id: string | null
          mollie_transaction_id: string | null
          notes: string | null
          original_amount: number | null
          paid_at: string | null
          paid_externally: boolean | null
          payment_amount: number | null
          payment_status: string
          player_id: string | null
          reminder_sent_at: string | null
          slot_id: string
          status: string
          updated_at: string
        }
        Insert: {
          court_type?: string | null
          created_at?: string
          discount_amount?: number | null
          discount_reason?: string | null
          guest_player_id?: string | null
          id?: string
          mollie_payment_id?: string | null
          mollie_transaction_id?: string | null
          notes?: string | null
          original_amount?: number | null
          paid_at?: string | null
          paid_externally?: boolean | null
          payment_amount?: number | null
          payment_status?: string
          player_id?: string | null
          reminder_sent_at?: string | null
          slot_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          court_type?: string | null
          created_at?: string
          discount_amount?: number | null
          discount_reason?: string | null
          guest_player_id?: string | null
          id?: string
          mollie_payment_id?: string | null
          mollie_transaction_id?: string | null
          notes?: string | null
          original_amount?: number | null
          paid_at?: string | null
          paid_externally?: boolean | null
          payment_amount?: number | null
          payment_status?: string
          player_id?: string | null
          reminder_sent_at?: string | null
          slot_id?: string
          status?: string
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
            foreignKeyName: "bookings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
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
      certifications: {
        Row: {
          country: string
          created_at: string
          description: string | null
          display_order: number | null
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          country?: string
          created_at?: string
          description?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          country?: string
          created_at?: string
          description?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: []
      }
      club_followers: {
        Row: {
          club_profile_id: string
          created_at: string
          id: string
          notify_new_availability: boolean
          player_id: string
        }
        Insert: {
          club_profile_id: string
          created_at?: string
          id?: string
          notify_new_availability?: boolean
          player_id: string
        }
        Update: {
          club_profile_id?: string
          created_at?: string
          id?: string
          notify_new_availability?: boolean
          player_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_followers_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_followers_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_followers_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      club_managers: {
        Row: {
          club_profile_id: string
          created_at: string
          id: string
          invited_by: string | null
          role: string
          user_id: string
        }
        Insert: {
          club_profile_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          user_id: string
        }
        Update: {
          club_profile_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_managers_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_managers_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_managers_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      club_mollie_accounts: {
        Row: {
          access_token: string | null
          charges_enabled: boolean
          club_profile_id: string
          created_at: string
          id: string
          mollie_organization_id: string
          onboarding_complete: boolean
          payouts_enabled: boolean
          refresh_token: string | null
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          charges_enabled?: boolean
          club_profile_id: string
          created_at?: string
          id?: string
          mollie_organization_id: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          charges_enabled?: boolean
          club_profile_id?: string
          created_at?: string
          id?: string
          mollie_organization_id?: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_stripe_accounts_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: true
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_stripe_accounts_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: true
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_stripe_accounts_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: true
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      club_players: {
        Row: {
          club_profile_id: string
          created_at: string
          email: string
          full_name: string
          has_trained: boolean
          id: string
          linked_profile_id: string | null
          notes: string | null
          phone: string | null
          rating_system: string
          skill_rating: number | null
          source: string | null
          updated_at: string
        }
        Insert: {
          club_profile_id: string
          created_at?: string
          email: string
          full_name: string
          has_trained?: boolean
          id?: string
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string | null
          rating_system?: string
          skill_rating?: number | null
          source?: string | null
          updated_at?: string
        }
        Update: {
          club_profile_id?: string
          created_at?: string
          email?: string
          full_name?: string
          has_trained?: boolean
          id?: string
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string | null
          rating_system?: string
          skill_rating?: number | null
          source?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_players_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_players_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_players_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_players_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_players_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_players_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      club_profile_views: {
        Row: {
          club_profile_id: string
          id: string
          session_id: string | null
          viewed_at: string
        }
        Insert: {
          club_profile_id: string
          id?: string
          session_id?: string | null
          viewed_at?: string
        }
        Update: {
          club_profile_id?: string
          id?: string
          session_id?: string | null
          viewed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_profile_views_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_profile_views_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_profile_views_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      club_profiles: {
        Row: {
          banner_url: string | null
          claimed_at: string
          contact_email: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_verified: boolean
          location_id: string
          logo_url: string | null
          mollie_customer_id: string | null
          phone: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          banner_url?: string | null
          claimed_at?: string
          contact_email?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_verified?: boolean
          location_id: string
          logo_url?: string | null
          mollie_customer_id?: string | null
          phone?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          banner_url?: string | null
          claimed_at?: string
          contact_email?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_verified?: boolean
          location_id?: string
          logo_url?: string | null
          mollie_customer_id?: string | null
          phone?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_profiles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      club_tournaments: {
        Row: {
          club_profile_id: string
          created_at: string
          description: string | null
          end_date: string | null
          id: string
          image_url: string | null
          is_published: boolean
          name: string
          registration_url: string | null
          start_date: string
          updated_at: string
        }
        Insert: {
          club_profile_id: string
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          image_url?: string | null
          is_published?: boolean
          name: string
          registration_url?: string | null
          start_date: string
          updated_at?: string
        }
        Update: {
          club_profile_id?: string
          created_at?: string
          description?: string | null
          end_date?: string | null
          id?: string
          image_url?: string | null
          is_published?: boolean
          name?: string
          registration_url?: string | null
          start_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_tournaments_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_tournaments_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_tournaments_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      club_trainer_invitations: {
        Row: {
          club_profile_id: string
          created_at: string
          id: string
          invited_by: string
          message: string | null
          responded_at: string | null
          status: string
          token: string
          trainer_email: string
          trainer_profile_id: string | null
        }
        Insert: {
          club_profile_id: string
          created_at?: string
          id?: string
          invited_by: string
          message?: string | null
          responded_at?: string | null
          status?: string
          token?: string
          trainer_email: string
          trainer_profile_id?: string | null
        }
        Update: {
          club_profile_id?: string
          created_at?: string
          id?: string
          invited_by?: string
          message?: string | null
          responded_at?: string | null
          status?: string
          token?: string
          trainer_email?: string
          trainer_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "club_trainer_invitations_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_trainer_invitations_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_trainer_invitations_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_trainer_invitations_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_trainer_invitations_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      cycles: {
        Row: {
          created_at: string
          currency: string | null
          description: string | null
          end_date: string
          enrollment_deadline: string | null
          id: string
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_per_session: number | null
          settings: Json | null
          start_date: string
          status: string
          total_price: number | null
          type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          description?: string | null
          end_date: string
          enrollment_deadline?: string | null
          id?: string
          location_id?: string | null
          name: string
          owner_id: string
          owner_type: string
          price_per_session?: number | null
          settings?: Json | null
          start_date: string
          status?: string
          total_price?: number | null
          type?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          description?: string | null
          end_date?: string
          enrollment_deadline?: string | null
          id?: string
          location_id?: string | null
          name?: string
          owner_id?: string
          owner_type?: string
          price_per_session?: number | null
          settings?: Json | null
          start_date?: string
          status?: string
          total_price?: number | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cycles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_players: {
        Row: {
          created_at: string
          email: string | null
          full_name: string
          has_trained: boolean
          id: string
          linked_profile_id: string | null
          notes: string | null
          phone: string | null
          rating_system: string
          skill_rating: number | null
          source: string | null
          trainer_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name: string
          has_trained?: boolean
          id?: string
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string | null
          rating_system?: string
          skill_rating?: number | null
          source?: string | null
          trainer_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string
          has_trained?: boolean
          id?: string
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string | null
          rating_system?: string
          skill_rating?: number | null
          source?: string | null
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
            foreignKeyName: "guest_players_linked_profile_id_fkey"
            columns: ["linked_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      intake_requests: {
        Row: {
          consent_given: boolean
          created_at: string
          cycle_id: string
          email: string
          full_name: string
          id: string
          lesson_type: string[]
          location_id: string | null
          notes: string | null
          phone: string | null
          player_id: string
          preferred_days: string[]
          preferred_duration_minutes: number | null
          preferred_time_windows: Json
          preferred_trainer_ids: string[] | null
          rating: number | null
          rating_system: string | null
          sessions_per_week: number | null
          skip_reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          consent_given?: boolean
          created_at?: string
          cycle_id: string
          email: string
          full_name: string
          id?: string
          lesson_type: string[]
          location_id?: string | null
          notes?: string | null
          phone?: string | null
          player_id: string
          preferred_days: string[]
          preferred_duration_minutes?: number | null
          preferred_time_windows: Json
          preferred_trainer_ids?: string[] | null
          rating?: number | null
          rating_system?: string | null
          sessions_per_week?: number | null
          skip_reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          consent_given?: boolean
          created_at?: string
          cycle_id?: string
          email?: string
          full_name?: string
          id?: string
          lesson_type?: string[]
          location_id?: string | null
          notes?: string | null
          phone?: string | null
          player_id?: string
          preferred_days?: string[]
          preferred_duration_minutes?: number | null
          preferred_time_windows?: Json
          preferred_trainer_ids?: string[] | null
          rating?: number | null
          rating_system?: string | null
          sessions_per_week?: number | null
          skip_reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "intake_requests_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_requests_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_requests_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_requests_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_requests_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
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
          player_business_name: string | null
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
          player_business_name?: string | null
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
          player_business_name?: string | null
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
            foreignKeyName: "invoices_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      location_requests: {
        Row: {
          city: string
          context_id: string | null
          country: string
          created_at: string
          created_location_id: string | null
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          postal_code: string | null
          rejection_reason: string | null
          request_context: string
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          street_address: string | null
          updated_at: string
          website_url: string | null
        }
        Insert: {
          city: string
          context_id?: string | null
          country?: string
          created_at?: string
          created_location_id?: string | null
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          rejection_reason?: string | null
          request_context?: string
          requested_by: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          street_address?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Update: {
          city?: string
          context_id?: string | null
          country?: string
          created_at?: string
          created_location_id?: string | null
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          postal_code?: string | null
          rejection_reason?: string | null
          request_context?: string
          requested_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          street_address?: string | null
          updated_at?: string
          website_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "location_requests_created_location_id_fkey"
            columns: ["created_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          city: string
          country: string
          created_at: string
          description: string | null
          email: string | null
          facebook_url: string | null
          google_maps_url: string | null
          google_rating: number | null
          google_review_count: number | null
          id: string
          indoor_courts: number | null
          instagram_url: string | null
          is_active: boolean
          latitude: number | null
          logo_fetched_at: string | null
          logo_url: string | null
          longitude: number | null
          name: string
          number_of_courts: number | null
          opening_hours: string | null
          outdoor_courts: number | null
          phone: string | null
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
          description?: string | null
          email?: string | null
          facebook_url?: string | null
          google_maps_url?: string | null
          google_rating?: number | null
          google_review_count?: number | null
          id?: string
          indoor_courts?: number | null
          instagram_url?: string | null
          is_active?: boolean
          latitude?: number | null
          logo_fetched_at?: string | null
          logo_url?: string | null
          longitude?: number | null
          name: string
          number_of_courts?: number | null
          opening_hours?: string | null
          outdoor_courts?: number | null
          phone?: string | null
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
          description?: string | null
          email?: string | null
          facebook_url?: string | null
          google_maps_url?: string | null
          google_rating?: number | null
          google_review_count?: number | null
          id?: string
          indoor_courts?: number | null
          instagram_url?: string | null
          is_active?: boolean
          latitude?: number | null
          logo_fetched_at?: string | null
          logo_url?: string | null
          longitude?: number | null
          name?: string
          number_of_courts?: number | null
          opening_hours?: string | null
          outdoor_courts?: number | null
          phone?: string | null
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
          booking_cancelled: string
          booking_confirmation: string
          booking_reminder: string
          created_at: string
          id: string
          new_booking: string
          new_follower: string
          new_player: string
          new_registration: string
          new_review: string
          open_slots_digest: string
          payment_receipt: string
          payment_received: string
          upcoming_schedule_digest: string
          upcoming_sessions_digest: string
          updated_at: string
          user_id: string
          waitlist_update: string
        }
        Insert: {
          booking_cancelled?: string
          booking_confirmation?: string
          booking_reminder?: string
          created_at?: string
          id?: string
          new_booking?: string
          new_follower?: string
          new_player?: string
          new_registration?: string
          new_review?: string
          open_slots_digest?: string
          payment_receipt?: string
          payment_received?: string
          upcoming_schedule_digest?: string
          upcoming_sessions_digest?: string
          updated_at?: string
          user_id: string
          waitlist_update?: string
        }
        Update: {
          booking_cancelled?: string
          booking_confirmation?: string
          booking_reminder?: string
          created_at?: string
          id?: string
          new_booking?: string
          new_follower?: string
          new_player?: string
          new_registration?: string
          new_review?: string
          open_slots_digest?: string
          payment_receipt?: string
          payment_received?: string
          upcoming_schedule_digest?: string
          upcoming_sessions_digest?: string
          updated_at?: string
          user_id?: string
          waitlist_update?: string
        }
        Relationships: []
      }
      notification_queue: {
        Row: {
          created_at: string
          id: string
          notification_type: string
          payload: Json
          processed_at: string | null
          scheduled_for: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          notification_type: string
          payload?: Json
          processed_at?: string | null
          scheduled_for: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          notification_type?: string
          payload?: Json
          processed_at?: string | null
          scheduled_for?: string
          user_id?: string
        }
        Relationships: []
      }
      onboarding_email_logs: {
        Row: {
          email: string
          id: string
          queue_id: string | null
          sent_at: string
          status: string
          subject: string
          template_id: string
          user_id: string
        }
        Insert: {
          email: string
          id?: string
          queue_id?: string | null
          sent_at?: string
          status: string
          subject: string
          template_id: string
          user_id: string
        }
        Update: {
          email?: string
          id?: string
          queue_id?: string | null
          sent_at?: string
          status?: string
          subject?: string
          template_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_email_logs_queue_id_fkey"
            columns: ["queue_id"]
            isOneToOne: false
            referencedRelation: "onboarding_email_queue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_email_logs_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "onboarding_email_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_email_queue: {
        Row: {
          created_at: string
          email: string
          error_message: string | null
          id: string
          scheduled_for: string
          sent_at: string | null
          status: string
          template_id: string
          user_id: string
          user_name: string
          user_type: string
        }
        Insert: {
          created_at?: string
          email: string
          error_message?: string | null
          id?: string
          scheduled_for: string
          sent_at?: string | null
          status?: string
          template_id: string
          user_id: string
          user_name: string
          user_type: string
        }
        Update: {
          created_at?: string
          email?: string
          error_message?: string | null
          id?: string
          scheduled_for?: string
          sent_at?: string | null
          status?: string
          template_id?: string
          user_id?: string
          user_name?: string
          user_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_email_queue_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "onboarding_email_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_email_templates: {
        Row: {
          body_html: string
          created_at: string
          delay_days: number
          id: string
          is_active: boolean
          name: string
          subject: string
          trigger_type: string
          updated_at: string
          user_type: string
        }
        Insert: {
          body_html: string
          created_at?: string
          delay_days?: number
          id?: string
          is_active?: boolean
          name: string
          subject: string
          trigger_type: string
          updated_at?: string
          user_type: string
        }
        Update: {
          body_html?: string
          created_at?: string
          delay_days?: number
          id?: string
          is_active?: boolean
          name?: string
          subject?: string
          trigger_type?: string
          updated_at?: string
          user_type?: string
        }
        Relationships: []
      }
      partner_banners: {
        Row: {
          click_count: number
          club_profile_id: string | null
          created_at: string
          display_order: number
          end_date: string | null
          id: string
          image_url: string
          impression_count: number
          is_active: boolean
          link_url: string | null
          location_id: string | null
          name: string
          start_date: string | null
          updated_at: string
        }
        Insert: {
          click_count?: number
          club_profile_id?: string | null
          created_at?: string
          display_order?: number
          end_date?: string | null
          id?: string
          image_url: string
          impression_count?: number
          is_active?: boolean
          link_url?: string | null
          location_id?: string | null
          name: string
          start_date?: string | null
          updated_at?: string
        }
        Update: {
          click_count?: number
          club_profile_id?: string | null
          created_at?: string
          display_order?: number
          end_date?: string | null
          id?: string
          image_url?: string
          impression_count?: number
          is_active?: boolean
          link_url?: string | null
          location_id?: string | null
          name?: string
          start_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_banners_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_banners_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_banners_club_profile_id_fkey"
            columns: ["club_profile_id"]
            isOneToOne: false
            referencedRelation: "club_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_banners_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
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
          {
            foreignKeyName: "player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
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
          {
            foreignKeyName: "player_rating_history_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      profile_videos: {
        Row: {
          academy_profile_id: string | null
          created_at: string | null
          id: string
          sort_order: number | null
          title: string | null
          trainer_profile_id: string | null
          video_url: string
        }
        Insert: {
          academy_profile_id?: string | null
          created_at?: string | null
          id?: string
          sort_order?: number | null
          title?: string | null
          trainer_profile_id?: string | null
          video_url: string
        }
        Update: {
          academy_profile_id?: string | null
          created_at?: string | null
          id?: string
          sort_order?: number | null
          title?: string | null
          trainer_profile_id?: string | null
          video_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_videos_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_videos_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_videos_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_videos_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_videos_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          billing_address: string | null
          billing_btw_number: string | null
          billing_business_name: string | null
          bio: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          location: string | null
          phone: string | null
          rating_member_id: string | null
          rating_system: string
          skill_rating: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          bio?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          location?: string | null
          phone?: string | null
          rating_member_id?: string | null
          rating_system?: string
          skill_rating?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          bio?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          location?: string | null
          phone?: string | null
          rating_member_id?: string | null
          rating_system?: string
          skill_rating?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      proposed_assignments: {
        Row: {
          confidence_score: number | null
          created_at: string
          id: string
          intake_request_id: string
          rationale: Json | null
          slot_id: string
          status: string
          trainer_id: string
          updated_at: string
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          intake_request_id: string
          rationale?: Json | null
          slot_id: string
          status?: string
          trainer_id: string
          updated_at?: string
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          intake_request_id?: string
          rationale?: Json | null
          slot_id?: string
          status?: string
          trainer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposed_assignments_intake_request_id_fkey"
            columns: ["intake_request_id"]
            isOneToOne: false
            referencedRelation: "intake_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_assignments_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_assignments_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposed_assignments_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          created_at: string | null
          endpoint: string
          id: string
          identifier: string
          request_count: number | null
          window_start: string | null
        }
        Insert: {
          created_at?: string | null
          endpoint: string
          id?: string
          identifier: string
          request_count?: number | null
          window_start?: string | null
        }
        Update: {
          created_at?: string | null
          endpoint?: string
          id?: string
          identifier?: string
          request_count?: number | null
          window_start?: string | null
        }
        Relationships: []
      }
      rating_systems: {
        Row: {
          code: string
          country: string
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          lower_is_better: boolean
          max_rating: number
          member_id_label: string | null
          member_id_placeholder: string | null
          min_rating: number
          name: string
          step: number
        }
        Insert: {
          code: string
          country?: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          lower_is_better?: boolean
          max_rating: number
          member_id_label?: string | null
          member_id_placeholder?: string | null
          min_rating: number
          name: string
          step?: number
        }
        Update: {
          code?: string
          country?: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          lower_is_better?: boolean
          max_rating?: number
          member_id_label?: string | null
          member_id_placeholder?: string | null
          min_rating?: number
          name?: string
          step?: number
        }
        Relationships: []
      }
      review_tag_selections: {
        Row: {
          created_at: string
          id: string
          review_id: string
          tag_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          review_id: string
          tag_id: string
        }
        Update: {
          created_at?: string
          id?: string
          review_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_tag_selections_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_tag_selections_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "review_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      review_tags: {
        Row: {
          category: string
          created_at: string
          display_order: number | null
          id: string
          is_active: boolean
          name: string
          name_nl: string
        }
        Insert: {
          category: string
          created_at?: string
          display_order?: number | null
          id?: string
          is_active?: boolean
          name: string
          name_nl: string
        }
        Update: {
          category?: string
          created_at?: string
          display_order?: number | null
          id?: string
          is_active?: boolean
          name?: string
          name_nl?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          booking_id: string
          comment: string | null
          created_at: string
          id: string
          is_anonymous: boolean
          is_public: boolean
          player_id: string
          rating: number
          reviewer_name: string | null
          trainer_id: string
          updated_at: string
        }
        Insert: {
          booking_id: string
          comment?: string | null
          created_at?: string
          id?: string
          is_anonymous?: boolean
          is_public?: boolean
          player_id: string
          rating: number
          reviewer_name?: string | null
          trainer_id: string
          updated_at?: string
        }
        Update: {
          booking_id?: string
          comment?: string | null
          created_at?: string
          id?: string
          is_anonymous?: boolean
          is_public?: boolean
          player_id?: string
          rating?: number
          reviewer_name?: string | null
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
            foreignKeyName: "reviews_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      specializations: {
        Row: {
          created_at: string
          description: string | null
          display_order: number | null
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_order?: number | null
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: []
      }
      subscription_plans: {
        Row: {
          badge: string | null
          created_at: string
          description: string | null
          display_order: number
          features: Json | null
          id: string
          is_active: boolean
          is_highlighted: boolean
          mollie_plan_id_monthly: string | null
          mollie_plan_id_yearly: string | null
          mollie_product_id_monthly: string | null
          mollie_product_id_yearly: string | null
          monthly_price: number
          name: string
          plan_type: string
          platform_fee_flat: number | null
          platform_fee_percent: number
          tier: string
          updated_at: string
          yearly_price: number
        }
        Insert: {
          badge?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          features?: Json | null
          id?: string
          is_active?: boolean
          is_highlighted?: boolean
          mollie_plan_id_monthly?: string | null
          mollie_plan_id_yearly?: string | null
          mollie_product_id_monthly?: string | null
          mollie_product_id_yearly?: string | null
          monthly_price?: number
          name: string
          plan_type?: string
          platform_fee_flat?: number | null
          platform_fee_percent?: number
          tier: string
          updated_at?: string
          yearly_price?: number
        }
        Update: {
          badge?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          features?: Json | null
          id?: string
          is_active?: boolean
          is_highlighted?: boolean
          mollie_plan_id_monthly?: string | null
          mollie_plan_id_yearly?: string | null
          mollie_product_id_monthly?: string | null
          mollie_product_id_yearly?: string | null
          monthly_price?: number
          name?: string
          plan_type?: string
          platform_fee_flat?: number | null
          platform_fee_percent?: number
          tier?: string
          updated_at?: string
          yearly_price?: number
        }
        Relationships: []
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
            foreignKeyName: "trainer_followers_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_followers_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_followers_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
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
          relationship_type: string
          show_on_club_page: boolean
          trainer_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_primary?: boolean
          location_id: string
          relationship_type?: string
          show_on_club_page?: boolean
          trainer_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_primary?: boolean
          location_id?: string
          relationship_type?: string
          show_on_club_page?: boolean
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
          {
            foreignKeyName: "trainer_locations_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_mollie_accounts: {
        Row: {
          access_token: string | null
          charges_enabled: boolean
          created_at: string
          id: string
          mollie_organization_id: string
          onboarding_complete: boolean
          payouts_enabled: boolean
          refresh_token: string | null
          token_expires_at: string | null
          trainer_id: string
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          charges_enabled?: boolean
          created_at?: string
          id?: string
          mollie_organization_id: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          trainer_id: string
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          charges_enabled?: boolean
          created_at?: string
          id?: string
          mollie_organization_id?: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
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
          {
            foreignKeyName: "trainer_stripe_accounts_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_onboarding: {
        Row: {
          completed_at: string | null
          created_at: string
          current_step: number
          followup_answer: string | null
          goal: string | null
          goal_other_text: string | null
          icd_responses: Json | null
          id: string
          setup_dismissed_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          current_step?: number
          followup_answer?: string | null
          goal?: string | null
          goal_other_text?: string | null
          icd_responses?: Json | null
          id?: string
          setup_dismissed_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          current_step?: number
          followup_answer?: string | null
          goal?: string | null
          goal_other_text?: string | null
          icd_responses?: Json | null
          id?: string
          setup_dismissed_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
          {
            foreignKeyName: "trainer_profile_views_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
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
          coaching_method: string | null
          coaching_since_year: number | null
          created_at: string
          default_vat_rate: number | null
          experience_years: number | null
          favourite_quote: string | null
          general_terms: string | null
          hourly_rate: number | null
          iban: string | null
          id: string
          invoice_forward_emails: string[] | null
          invoice_logo_url: string | null
          invoice_next_number: number | null
          invoice_prefix: string | null
          is_public: boolean | null
          is_verified: boolean | null
          knltb_rating: number | null
          kvk_number: string | null
          mollie_customer_id: string | null
          payment_terms_days: number | null
          platform_fee_override: number | null
          preferred_max_rating: number | null
          preferred_min_rating: number | null
          preferred_rating_system: string | null
          require_booking_approval: boolean | null
          schedule_weeks_ahead: number
          slot_duration_minutes: number
          slot_gap_minutes: number
          slug: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          specializations: string[] | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          trainer_rating_system: string | null
          trial_ends_at: string | null
          trial_started_at: string | null
          updated_at: string
          use_manual_invoicing: boolean | null
          user_id: string
          video_url: string | null
          waiting_list_enabled: boolean
          website_url: string | null
        }
        Insert: {
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          certifications?: string[] | null
          coaching_method?: string | null
          coaching_since_year?: number | null
          created_at?: string
          default_vat_rate?: number | null
          experience_years?: number | null
          favourite_quote?: string | null
          general_terms?: string | null
          hourly_rate?: number | null
          iban?: string | null
          id?: string
          invoice_forward_emails?: string[] | null
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          mollie_customer_id?: string | null
          payment_terms_days?: number | null
          platform_fee_override?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number
          slot_duration_minutes?: number
          slot_gap_minutes?: number
          slug?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          specializations?: string[] | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          use_manual_invoicing?: boolean | null
          user_id: string
          video_url?: string | null
          waiting_list_enabled?: boolean
          website_url?: string | null
        }
        Update: {
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          certifications?: string[] | null
          coaching_method?: string | null
          coaching_since_year?: number | null
          created_at?: string
          default_vat_rate?: number | null
          experience_years?: number | null
          favourite_quote?: string | null
          general_terms?: string | null
          hourly_rate?: number | null
          iban?: string | null
          id?: string
          invoice_forward_emails?: string[] | null
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          mollie_customer_id?: string | null
          payment_terms_days?: number | null
          platform_fee_override?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number
          slot_duration_minutes?: number
          slot_gap_minutes?: number
          slug?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          specializations?: string[] | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          use_manual_invoicing?: boolean | null
          user_id?: string
          video_url?: string | null
          waiting_list_enabled?: boolean
          website_url?: string | null
        }
        Relationships: []
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
          {
            foreignKeyName: "trainer_working_hours_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
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
      waiting_list_entries: {
        Row: {
          contacted_at: string | null
          created_at: string
          group_size: number | null
          has_group: boolean
          id: string
          lesson_type: string
          notes: string | null
          owner_id: string
          owner_type: string
          player_id: string
          preferred_days: string[] | null
          preferred_time_windows: Json | null
          rating: number | null
          rating_system: string | null
          status: string
          updated_at: string
        }
        Insert: {
          contacted_at?: string | null
          created_at?: string
          group_size?: number | null
          has_group?: boolean
          id?: string
          lesson_type: string
          notes?: string | null
          owner_id: string
          owner_type: string
          player_id: string
          preferred_days?: string[] | null
          preferred_time_windows?: Json | null
          rating?: number | null
          rating_system?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          contacted_at?: string | null
          created_at?: string
          group_size?: number | null
          has_group?: boolean
          id?: string
          lesson_type?: string
          notes?: string | null
          owner_id?: string
          owner_type?: string
          player_id?: string
          preferred_days?: string[] | null
          preferred_time_windows?: Json | null
          rating?: number | null
          rating_system?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiting_list_entries_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiting_list_entries_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiting_list_entries_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      academy_mollie_status: {
        Row: {
          academy_profile_id: string | null
          charges_enabled: boolean | null
          is_connected: boolean | null
          onboarding_complete: boolean | null
        }
        Insert: {
          academy_profile_id?: string | null
          charges_enabled?: boolean | null
          is_connected?: never
          onboarding_complete?: boolean | null
        }
        Update: {
          academy_profile_id?: string | null
          charges_enabled?: boolean | null
          is_connected?: never
          onboarding_complete?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: true
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: true
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: true
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_profiles_public: {
        Row: {
          banner_url: string | null
          country: string | null
          description: string | null
          id: string | null
          is_public: boolean | null
          is_verified: boolean | null
          logo_url: string | null
          name: string | null
          slug: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          subscription_status: string | null
          waiting_list_enabled: boolean | null
          website_url: string | null
        }
        Insert: {
          banner_url?: string | null
          country?: string | null
          description?: string | null
          id?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          logo_url?: string | null
          name?: string | null
          slug?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_status?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
        }
        Update: {
          banner_url?: string | null
          country?: string | null
          description?: string | null
          id?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          logo_url?: string | null
          name?: string | null
          slug?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_status?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
        }
        Relationships: []
      }
      academy_profiles_safe: {
        Row: {
          banner_url: string | null
          contact_email: string | null
          country: string | null
          created_at: string | null
          description: string | null
          id: string | null
          is_public: boolean | null
          is_verified: boolean | null
          logo_url: string | null
          name: string | null
          phone: string | null
          slug: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          subscription_ends_at: string | null
          subscription_status: string | null
          subscription_tier: string | null
          trial_ends_at: string | null
          updated_at: string | null
          website_url: string | null
        }
        Insert: {
          banner_url?: string | null
          contact_email?: string | null
          country?: string | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          logo_url?: string | null
          name?: string | null
          phone?: string | null
          slug?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_ends_at?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          website_url?: string | null
        }
        Update: {
          banner_url?: string | null
          contact_email?: string | null
          country?: string | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          logo_url?: string | null
          name?: string | null
          phone?: string | null
          slug?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_ends_at?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          website_url?: string | null
        }
        Relationships: []
      }
      club_profiles_public: {
        Row: {
          banner_url: string | null
          claimed_at: string | null
          created_at: string | null
          description: string | null
          id: string | null
          is_verified: boolean | null
          location_id: string | null
          logo_url: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          subscription_status: string | null
          subscription_tier: string | null
          updated_at: string | null
        }
        Insert: {
          banner_url?: string | null
          claimed_at?: string | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          is_verified?: boolean | null
          location_id?: string | null
          logo_url?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          updated_at?: string | null
        }
        Update: {
          banner_url?: string | null
          claimed_at?: string | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          is_verified?: boolean | null
          location_id?: string | null
          logo_url?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "club_profiles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      club_profiles_safe: {
        Row: {
          banner_url: string | null
          created_at: string | null
          description: string | null
          id: string | null
          is_verified: boolean | null
          location_id: string | null
          logo_url: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          updated_at: string | null
        }
        Insert: {
          banner_url?: string | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          is_verified?: boolean | null
          location_id?: string | null
          logo_url?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          updated_at?: string | null
        }
        Update: {
          banner_url?: string | null
          created_at?: string | null
          description?: string | null
          id?: string | null
          is_verified?: boolean | null
          location_id?: string | null
          logo_url?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "club_profiles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: true
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles_public: {
        Row: {
          avatar_url: string | null
          bio: string | null
          created_at: string | null
          full_name: string | null
          id: string | null
          location: string | null
          rating_member_id: string | null
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
          location?: string | null
          rating_member_id?: string | null
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
          location?: string | null
          rating_member_id?: string | null
          rating_system?: string | null
          skill_rating?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      profiles_safe: {
        Row: {
          avatar_url: string | null
          bio: string | null
          created_at: string | null
          full_name: string | null
          id: string | null
          location: string | null
          rating_member_id: string | null
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
          location?: string | null
          rating_member_id?: string | null
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
          location?: string | null
          rating_member_id?: string | null
          rating_system?: string | null
          skill_rating?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      trainer_mollie_status: {
        Row: {
          charges_enabled: boolean | null
          is_connected: boolean | null
          onboarding_complete: boolean | null
          trainer_id: string | null
        }
        Insert: {
          charges_enabled?: boolean | null
          is_connected?: never
          onboarding_complete?: boolean | null
          trainer_id?: string | null
        }
        Update: {
          charges_enabled?: boolean | null
          is_connected?: never
          onboarding_complete?: boolean | null
          trainer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trainer_stripe_accounts_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_stripe_accounts_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_profiles_safe: {
        Row: {
          certifications: string[] | null
          coaching_method: string | null
          created_at: string | null
          experience_years: number | null
          favourite_quote: string | null
          hourly_rate: number | null
          id: string | null
          is_public: boolean | null
          is_verified: boolean | null
          knltb_rating: number | null
          preferred_max_rating: number | null
          preferred_min_rating: number | null
          preferred_rating_system: string | null
          require_booking_approval: boolean | null
          schedule_weeks_ahead: number | null
          slot_duration_minutes: number | null
          slug: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          specializations: string[] | null
          subscription_status: string | null
          trainer_rating_system: string | null
          trial_ends_at: string | null
          updated_at: string | null
          use_manual_invoicing: boolean | null
          user_id: string | null
          video_url: string | null
          waiting_list_enabled: boolean | null
          website_url: string | null
        }
        Insert: {
          certifications?: string[] | null
          coaching_method?: string | null
          created_at?: string | null
          experience_years?: never
          favourite_quote?: string | null
          hourly_rate?: number | null
          id?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number | null
          slot_duration_minutes?: number | null
          slug?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          specializations?: string[] | null
          subscription_status?: string | null
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          use_manual_invoicing?: boolean | null
          user_id?: string | null
          video_url?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
        }
        Update: {
          certifications?: string[] | null
          coaching_method?: string | null
          created_at?: string | null
          experience_years?: never
          favourite_quote?: string | null
          hourly_rate?: number | null
          id?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number | null
          slot_duration_minutes?: number | null
          slug?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          specializations?: string[] | null
          subscription_status?: string | null
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          use_manual_invoicing?: boolean | null
          user_id?: string | null
          video_url?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      academy_has_managers: {
        Args: { _academy_profile_id: string }
        Returns: boolean
      }
      check_logo_fetch_job_status: { Args: never; Returns: Json }
      club_has_managers: {
        Args: { _club_profile_id: string }
        Returns: boolean
      }
      generate_location_slug: {
        Args: { city: string; name: string }
        Returns: string
      }
      generate_trainer_slug: { Args: { full_name: string }; Returns: string }
      generate_unique_trainer_slug: {
        Args: { _full_name: string; _trainer_id: string }
        Returns: string
      }
      get_user_academy_ids: { Args: { _user_id: string }; Returns: string[] }
      get_user_club_ids: { Args: { _user_id: string }; Returns: string[] }
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
      is_academy_manager: {
        Args: { _academy_profile_id: string; _user_id: string }
        Returns: boolean
      }
      is_academy_owner: {
        Args: { _academy_profile_id: string; _user_id: string }
        Returns: boolean
      }
      is_academy_trainer: {
        Args: { _trainer_profile_id: string; _user_id: string }
        Returns: boolean
      }
      is_active_academy_trainer: {
        Args: { _trainer_profile_id: string; _user_id: string }
        Returns: boolean
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_any_academy_manager: { Args: { _user_id: string }; Returns: boolean }
      is_any_club_manager: { Args: { _user_id: string }; Returns: boolean }
      is_club_manager: {
        Args: { _club_profile_id: string; _user_id: string }
        Returns: boolean
      }
      is_club_owner: {
        Args: { _club_profile_id: string; _user_id: string }
        Returns: boolean
      }
      is_player: { Args: { _user_id: string }; Returns: boolean }
      is_player_of_trainer: { Args: { p_player_id: string }; Returns: boolean }
      is_trainer: { Args: { _user_id: string }; Returns: boolean }
      queue_onboarding_emails: {
        Args: {
          p_email: string
          p_trigger_type: string
          p_user_id: string
          p_user_name: string
          p_user_type: string
        }
        Returns: undefined
      }
      schedule_logo_fetch_job: { Args: never; Returns: number }
      unschedule_logo_fetch_job: { Args: never; Returns: undefined }
    }
    Enums: {
      app_role:
        | "player"
        | "trainer"
        | "admin"
        | "club_manager"
        | "club"
        | "academy"
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
      app_role: [
        "player",
        "trainer",
        "admin",
        "club_manager",
        "club",
        "academy",
      ],
    },
  },
} as const
