export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      academy_cycle_categories: {
        Row: {
          academy_profile_id: string
          color: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          academy_profile_id: string
          color?: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string
          color?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "academy_profiles_owner"
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
          disconnected_at: string | null
          id: string
          mollie_organization_id: string
          onboarding_complete: boolean
          payouts_enabled: boolean
          refresh_token: string | null
          token_expires_at: string | null
          token_refreshing_at: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id: string
          access_token?: string | null
          charges_enabled?: boolean
          created_at?: string
          disconnected_at?: string | null
          id?: string
          mollie_organization_id: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          token_refreshing_at?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string
          access_token?: string | null
          charges_enabled?: boolean
          created_at?: string
          disconnected_at?: string | null
          id?: string
          mollie_organization_id?: string
          onboarding_complete?: boolean
          payouts_enabled?: boolean
          refresh_token?: string | null
          token_expires_at?: string | null
          token_refreshing_at?: string | null
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
            referencedRelation: "academy_profiles_owner"
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
      academy_player_locations: {
        Row: {
          academy_profile_id: string
          created_at: string
          created_by: string | null
          dismissed: boolean
          guest_player_id: string | null
          id: string
          location_id: string
          profile_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id: string
          created_at?: string
          created_by?: string | null
          dismissed?: boolean
          guest_player_id?: string | null
          id?: string
          location_id: string
          profile_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string
          created_at?: string
          created_by?: string | null
          dismissed?: boolean
          guest_player_id?: string | null
          id?: string
          location_id?: string
          profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_player_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_guest_player_id_fkey"
            columns: ["guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_locations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_player_metadata: {
        Row: {
          academy_profile_id: string | null
          billing_email: string | null
          created_at: string
          guest_player_id: string | null
          id: string
          notes: string | null
          preferred_location_id: string | null
          profile_id: string | null
          remove_reason: string | null
          removed_at: string | null
          removed_by: string | null
          tag_ids: string[]
          trainer_profile_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id?: string | null
          billing_email?: string | null
          created_at?: string
          guest_player_id?: string | null
          id?: string
          notes?: string | null
          preferred_location_id?: string | null
          profile_id?: string | null
          remove_reason?: string | null
          removed_at?: string | null
          removed_by?: string | null
          tag_ids?: string[]
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string | null
          billing_email?: string | null
          created_at?: string
          guest_player_id?: string | null
          id?: string
          notes?: string | null
          preferred_location_id?: string | null
          profile_id?: string | null
          remove_reason?: string | null
          removed_at?: string | null
          removed_by?: string | null
          tag_ids?: string[]
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_player_metadata_guest_player_id_fkey"
            columns: ["guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_preferred_location_id_fkey"
            columns: ["preferred_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_metadata_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_player_tags: {
        Row: {
          academy_profile_id: string | null
          color: string
          created_at: string
          id: string
          name: string
          trainer_profile_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name: string
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string | null
          color?: string
          created_at?: string
          id?: string
          name?: string
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_player_tags_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_tags_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_player_tags_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
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
            referencedRelation: "academy_profiles_owner"
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
          bic: string | null
          btw_number: string | null
          business_address: string | null
          business_name: string | null
          contact_email: string | null
          country: string
          created_at: string
          created_by: string | null
          default_vat_rate: number | null
          description: string | null
          general_terms: string | null
          iban: string | null
          id: string
          invoice_banner_color: string | null
          invoice_email_message: string | null
          invoice_email_subject: string | null
          invoice_forward_emails: string[] | null
          invoice_include_year: boolean
          invoice_language: string
          invoice_logo_url: string | null
          invoice_next_number: number | null
          invoice_prefix: string | null
          invoice_reply_to_email: string | null
          is_public: boolean
          is_verified: boolean
          kvk_number: string | null
          last_processed_payment_id: string | null
          logo_url: string | null
          mollie_customer_id: string | null
          name: string
          payment_terms_days: number | null
          phone: string | null
          platform_fee_override: number | null
          price_display_mode: string
          rebook_rules: string | null
          slug: string
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          stripe_customer_id: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          timezone: string
          trial_ends_at: string | null
          updated_at: string
          waiting_list_enabled: boolean
          warning_max_age_diff_years: number | null
          warning_max_rating_spread: number | null
          website_url: string | null
          welcome_message: string | null
        }
        Insert: {
          banner_url?: string | null
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          contact_email?: string | null
          country?: string
          created_at?: string
          created_by?: string | null
          default_vat_rate?: number | null
          description?: string | null
          general_terms?: string | null
          iban?: string | null
          id?: string
          invoice_banner_color?: string | null
          invoice_email_message?: string | null
          invoice_email_subject?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean
          invoice_language?: string
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean
          is_verified?: boolean
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          logo_url?: string | null
          mollie_customer_id?: string | null
          name: string
          payment_terms_days?: number | null
          phone?: string | null
          platform_fee_override?: number | null
          price_display_mode?: string
          rebook_rules?: string | null
          slug: string
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          waiting_list_enabled?: boolean
          warning_max_age_diff_years?: number | null
          warning_max_rating_spread?: number | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Update: {
          banner_url?: string | null
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          contact_email?: string | null
          country?: string
          created_at?: string
          created_by?: string | null
          default_vat_rate?: number | null
          description?: string | null
          general_terms?: string | null
          iban?: string | null
          id?: string
          invoice_banner_color?: string | null
          invoice_email_message?: string | null
          invoice_email_subject?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean
          invoice_language?: string
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean
          is_verified?: boolean
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          logo_url?: string | null
          mollie_customer_id?: string | null
          name?: string
          payment_terms_days?: number | null
          phone?: string | null
          platform_fee_override?: number | null
          price_display_mode?: string
          rebook_rules?: string | null
          slug?: string
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string
          trial_ends_at?: string | null
          updated_at?: string
          waiting_list_enabled?: boolean
          warning_max_age_diff_years?: number | null
          warning_max_rating_spread?: number | null
          website_url?: string | null
          welcome_message?: string | null
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
      articles: {
        Row: {
          author_name: string
          body_html: string | null
          body_md: string | null
          canonical_id: string
          cover_image_alt: string | null
          cover_image_generated_at: string | null
          cover_image_url: string | null
          created_at: string
          excerpt: string | null
          id: string
          locale: string
          meta_description: string | null
          meta_title: string | null
          primary_keyword: string | null
          published_at: string | null
          slug: string
          status: string
          tags: string[] | null
          title: string
          updated_at: string
        }
        Insert: {
          author_name?: string
          body_html?: string | null
          body_md?: string | null
          canonical_id?: string
          cover_image_alt?: string | null
          cover_image_generated_at?: string | null
          cover_image_url?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          locale?: string
          meta_description?: string | null
          meta_title?: string | null
          primary_keyword?: string | null
          published_at?: string | null
          slug: string
          status?: string
          tags?: string[] | null
          title: string
          updated_at?: string
        }
        Update: {
          author_name?: string
          body_html?: string | null
          body_md?: string | null
          canonical_id?: string
          cover_image_alt?: string | null
          cover_image_generated_at?: string | null
          cover_image_url?: string | null
          created_at?: string
          excerpt?: string | null
          id?: string
          locale?: string
          meta_description?: string | null
          meta_title?: string | null
          primary_keyword?: string | null
          published_at?: string | null
          slug?: string
          status?: string
          tags?: string[] | null
          title?: string
          updated_at?: string
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
          is_public: boolean
          is_recurring: boolean
          lesson_id: string | null
          location_id: string | null
          max_participants: number | null
          max_rating: number | null
          member_window_ends_at: string | null
          member_window_starts_at: string | null
          min_participants: number | null
          min_rating: number | null
          price_per_session: number | null
          prices_include_vat: boolean
          priority_source_slot_id: string | null
          priority_window_ends_at: string | null
          priority_window_starts_at: string | null
          public_release_status: string
          rating_system: string | null
          recurrence_rule: string | null
          source_cycle_id: string | null
          split_payment: boolean | null
          start_time: string
          total_price: number | null
          trainer_id: string
          training_level: string | null
          whole_slot_booking: boolean
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
          is_public?: boolean
          is_recurring?: boolean
          lesson_id?: string | null
          location_id?: string | null
          max_participants?: number | null
          max_rating?: number | null
          member_window_ends_at?: string | null
          member_window_starts_at?: string | null
          min_participants?: number | null
          min_rating?: number | null
          price_per_session?: number | null
          prices_include_vat?: boolean
          priority_source_slot_id?: string | null
          priority_window_ends_at?: string | null
          priority_window_starts_at?: string | null
          public_release_status?: string
          rating_system?: string | null
          recurrence_rule?: string | null
          source_cycle_id?: string | null
          split_payment?: boolean | null
          start_time: string
          total_price?: number | null
          trainer_id: string
          training_level?: string | null
          whole_slot_booking?: boolean
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
          is_public?: boolean
          is_recurring?: boolean
          lesson_id?: string | null
          location_id?: string | null
          max_participants?: number | null
          max_rating?: number | null
          member_window_ends_at?: string | null
          member_window_starts_at?: string | null
          min_participants?: number | null
          min_rating?: number | null
          price_per_session?: number | null
          prices_include_vat?: boolean
          priority_source_slot_id?: string | null
          priority_window_ends_at?: string | null
          priority_window_starts_at?: string | null
          public_release_status?: string
          rating_system?: string | null
          recurrence_rule?: string | null
          source_cycle_id?: string | null
          split_payment?: boolean | null
          start_time?: string
          total_price?: number | null
          trainer_id?: string
          training_level?: string | null
          whole_slot_booking?: boolean
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
            referencedRelation: "academy_profiles_owner"
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
            foreignKeyName: "availability_slots_cyclus_id_fkey"
            columns: ["cyclus_id"]
            isOneToOne: false
            referencedRelation: "cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_cyclus_id_fkey"
            columns: ["cyclus_id"]
            isOneToOne: false
            referencedRelation: "cycles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_slots_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
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
            foreignKeyName: "availability_slots_priority_source_slot_id_fkey"
            columns: ["priority_source_slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
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
            referencedRelation: "trainer_profiles_owner"
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
      banner_events: {
        Row: {
          banner_id: string
          created_at: string
          event_type: Database["public"]["Enums"]["banner_event_type"]
          id: string
          ip_hash: string | null
          page_url: string | null
          placement_id: string | null
          referrer: string | null
          session_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          banner_id: string
          created_at?: string
          event_type: Database["public"]["Enums"]["banner_event_type"]
          id?: string
          ip_hash?: string | null
          page_url?: string | null
          placement_id?: string | null
          referrer?: string | null
          session_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          banner_id?: string
          created_at?: string
          event_type?: Database["public"]["Enums"]["banner_event_type"]
          id?: string
          ip_hash?: string | null
          page_url?: string | null
          placement_id?: string | null
          referrer?: string | null
          session_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "banner_events_banner_id_fkey"
            columns: ["banner_id"]
            isOneToOne: false
            referencedRelation: "partner_banners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "banner_events_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "banner_placements"
            referencedColumns: ["id"]
          },
        ]
      }
      banner_placement_assignments: {
        Row: {
          banner_id: string
          created_at: string
          id: string
          is_active: boolean
          placement_id: string
          priority: number
          weight: number
        }
        Insert: {
          banner_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          placement_id: string
          priority?: number
          weight?: number
        }
        Update: {
          banner_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          placement_id?: string
          priority?: number
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "banner_placement_assignments_banner_id_fkey"
            columns: ["banner_id"]
            isOneToOne: false
            referencedRelation: "partner_banners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "banner_placement_assignments_placement_id_fkey"
            columns: ["placement_id"]
            isOneToOne: false
            referencedRelation: "banner_placements"
            referencedColumns: ["id"]
          },
        ]
      }
      banner_placements: {
        Row: {
          created_at: string
          description: string | null
          height: number | null
          id: string
          label: string
          rotation_interval_seconds: number
          slug: string
          width: number | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          height?: number | null
          id?: string
          label: string
          rotation_interval_seconds?: number
          slug: string
          width?: number | null
        }
        Update: {
          created_at?: string
          description?: string | null
          height?: number | null
          id?: string
          label?: string
          rotation_interval_seconds?: number
          slug?: string
          width?: number | null
        }
        Relationships: []
      }
      bookings: {
        Row: {
          amount_includes_extras: boolean | null
          anonymized_at: string | null
          court_type: string | null
          created_at: string
          discount_amount: number | null
          discount_reason: string | null
          guest_player_id: string | null
          hold_expires_at: string | null
          id: string
          lesson_id: string | null
          mollie_payment_id: string | null
          mollie_transaction_id: string | null
          notes: string | null
          original_amount: number | null
          paid_at: string | null
          paid_by_guest_player_id: string | null
          paid_by_player_id: string | null
          paid_externally: boolean | null
          payment_amount: number | null
          payment_status: string
          player_id: string | null
          public_token: string | null
          reminder_sent_at: string | null
          slot_id: string
          status: string
          updated_at: string
        }
        Insert: {
          amount_includes_extras?: boolean | null
          anonymized_at?: string | null
          court_type?: string | null
          created_at?: string
          discount_amount?: number | null
          discount_reason?: string | null
          guest_player_id?: string | null
          hold_expires_at?: string | null
          id?: string
          lesson_id?: string | null
          mollie_payment_id?: string | null
          mollie_transaction_id?: string | null
          notes?: string | null
          original_amount?: number | null
          paid_at?: string | null
          paid_by_guest_player_id?: string | null
          paid_by_player_id?: string | null
          paid_externally?: boolean | null
          payment_amount?: number | null
          payment_status?: string
          player_id?: string | null
          public_token?: string | null
          reminder_sent_at?: string | null
          slot_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount_includes_extras?: boolean | null
          anonymized_at?: string | null
          court_type?: string | null
          created_at?: string
          discount_amount?: number | null
          discount_reason?: string | null
          guest_player_id?: string | null
          hold_expires_at?: string | null
          id?: string
          lesson_id?: string | null
          mollie_payment_id?: string | null
          mollie_transaction_id?: string | null
          notes?: string | null
          original_amount?: number | null
          paid_at?: string | null
          paid_by_guest_player_id?: string | null
          paid_by_player_id?: string | null
          paid_externally?: boolean | null
          payment_amount?: number | null
          payment_status?: string
          player_id?: string | null
          public_token?: string | null
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
            foreignKeyName: "bookings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_paid_by_guest_player_id_fkey"
            columns: ["paid_by_guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_paid_by_player_id_fkey"
            columns: ["paid_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_paid_by_player_id_fkey"
            columns: ["paid_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_paid_by_player_id_fkey"
            columns: ["paid_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookings_paid_by_player_id_fkey"
            columns: ["paid_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
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
            referencedRelation: "profiles_owner"
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
      challenge_suggestions: {
        Row: {
          created_at: string
          description: string
          difficulty: string
          id: string
          mode: string
          name: string
          skill_benefit: string | null
          status: string
          submitter_email: string | null
          submitter_name: string | null
        }
        Insert: {
          created_at?: string
          description: string
          difficulty?: string
          id?: string
          mode?: string
          name: string
          skill_benefit?: string | null
          status?: string
          submitter_email?: string | null
          submitter_name?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          difficulty?: string
          id?: string
          mode?: string
          name?: string
          skill_benefit?: string | null
          status?: string
          submitter_email?: string | null
          submitter_name?: string | null
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
            referencedRelation: "club_profiles_owner"
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "club_profiles_owner"
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
            referencedRelation: "club_profiles_owner"
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
            referencedRelation: "club_profiles_owner"
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "club_profiles_owner"
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
          last_processed_payment_id: string | null
          location_id: string
          logo_url: string | null
          mollie_customer_id: string | null
          phone: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          stripe_customer_id: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          trial_ends_at: string | null
          updated_at: string
          welcome_message: string | null
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
          last_processed_payment_id?: string | null
          location_id: string
          logo_url?: string | null
          mollie_customer_id?: string | null
          phone?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          welcome_message?: string | null
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
          last_processed_payment_id?: string | null
          location_id?: string
          logo_url?: string | null
          mollie_customer_id?: string | null
          phone?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string
          welcome_message?: string | null
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
            referencedRelation: "club_profiles_owner"
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
            referencedRelation: "club_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
      coaching_note_views: {
        Row: {
          note_id: string
          profile_id: string
          seen_at: string
        }
        Insert: {
          note_id: string
          profile_id: string
          seen_at?: string
        }
        Update: {
          note_id?: string
          profile_id?: string
          seen_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "coaching_note_views_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "session_player_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coaching_note_views_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coaching_note_views_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coaching_note_views_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coaching_note_views_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      content_topics: {
        Row: {
          angle: string | null
          created_at: string
          id: string
          locales: string[]
          notes: string | null
          primary_keyword: string
          status: string
          updated_at: string
        }
        Insert: {
          angle?: string | null
          created_at?: string
          id?: string
          locales?: string[]
          notes?: string | null
          primary_keyword: string
          status?: string
          updated_at?: string
        }
        Update: {
          angle?: string | null
          created_at?: string
          id?: string
          locales?: string[]
          notes?: string | null
          primary_keyword?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      court_reviews: {
        Row: {
          best_thing: string | null
          created_at: string
          id: string
          improvement: string | null
          location_id: string
          overall_rating: number
          play_frequency: Database["public"]["Enums"]["play_frequency"] | null
          player_level: Database["public"]["Enums"]["player_level"] | null
          rating_atmosphere: number
          rating_beginner_friendly: number
          rating_booking: number
          rating_changing_rooms: number
          rating_glass: number
          rating_lighting: number
          rating_parking: number
          rating_space: number
          rating_surface: number
          rating_value: number
          status: Database["public"]["Enums"]["review_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          best_thing?: string | null
          created_at?: string
          id?: string
          improvement?: string | null
          location_id: string
          overall_rating?: number
          play_frequency?: Database["public"]["Enums"]["play_frequency"] | null
          player_level?: Database["public"]["Enums"]["player_level"] | null
          rating_atmosphere: number
          rating_beginner_friendly: number
          rating_booking: number
          rating_changing_rooms: number
          rating_glass: number
          rating_lighting: number
          rating_parking: number
          rating_space: number
          rating_surface: number
          rating_value: number
          status?: Database["public"]["Enums"]["review_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          best_thing?: string | null
          created_at?: string
          id?: string
          improvement?: string | null
          location_id?: string
          overall_rating?: number
          play_frequency?: Database["public"]["Enums"]["play_frequency"] | null
          player_level?: Database["public"]["Enums"]["player_level"] | null
          rating_atmosphere?: number
          rating_beginner_friendly?: number
          rating_booking?: number
          rating_changing_rooms?: number
          rating_glass?: number
          rating_lighting?: number
          rating_parking?: number
          rating_space?: number
          rating_surface?: number
          rating_value?: number
          status?: Database["public"]["Enums"]["review_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "court_reviews_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      cycles: {
        Row: {
          category_id: string | null
          commitment_invoiced_at: string | null
          created_at: string
          currency: string | null
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          id: string
          is_always_open: boolean
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_per_session: number | null
          price_table: Json | null
          settings: Json | null
          start_date: string | null
          status: string
          terms: string | null
          total_price: number | null
          type: string
          updated_at: string
        }
        Insert: {
          category_id?: string | null
          commitment_invoiced_at?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          end_date?: string | null
          enrollment_deadline?: string | null
          id?: string
          is_always_open?: boolean
          location_id?: string | null
          name: string
          owner_id: string
          owner_type: string
          price_per_session?: number | null
          price_table?: Json | null
          settings?: Json | null
          start_date?: string | null
          status?: string
          terms?: string | null
          total_price?: number | null
          type?: string
          updated_at?: string
        }
        Update: {
          category_id?: string | null
          commitment_invoiced_at?: string | null
          created_at?: string
          currency?: string | null
          description?: string | null
          end_date?: string | null
          enrollment_deadline?: string | null
          id?: string
          is_always_open?: boolean
          location_id?: string | null
          name?: string
          owner_id?: string
          owner_type?: string
          price_per_session?: number | null
          price_table?: Json | null
          settings?: Json | null
          start_date?: string | null
          status?: string
          terms?: string | null
          total_price?: number | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cycles_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "academy_cycle_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cycles_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      dismissed_slot_warnings: {
        Row: {
          created_at: string | null
          dismissed_by: string | null
          id: string
          slot_id: string
          warning_type: string
        }
        Insert: {
          created_at?: string | null
          dismissed_by?: string | null
          id?: string
          slot_id: string
          warning_type: string
        }
        Update: {
          created_at?: string | null
          dismissed_by?: string | null
          id?: string
          slot_id?: string
          warning_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "dismissed_slot_warnings_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      email_address_state: {
        Row: {
          email: string
          last_event_at: string | null
          last_event_type: string | null
          reason: string | null
          state: string
          updated_at: string
        }
        Insert: {
          email: string
          last_event_at?: string | null
          last_event_type?: string | null
          reason?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          email?: string
          last_event_at?: string | null
          last_event_type?: string | null
          reason?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_campaign_recipients: {
        Row: {
          attempt_count: number
          campaign_id: string
          created_at: string
          error_message: string | null
          id: string
          recipient_email: string
          recipient_name: string | null
          sent_at: string | null
          status: string
        }
        Insert: {
          attempt_count?: number
          campaign_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          recipient_email: string
          recipient_name?: string | null
          sent_at?: string | null
          status?: string
        }
        Update: {
          attempt_count?: number
          campaign_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          recipient_email?: string
          recipient_name?: string | null
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      email_campaign_templates: {
        Row: {
          academy_profile_id: string | null
          body_html: string
          created_at: string
          id: string
          name: string
          subject: string
          trainer_profile_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id?: string | null
          body_html: string
          created_at?: string
          id?: string
          name: string
          subject: string
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string | null
          body_html?: string
          created_at?: string
          id?: string
          name?: string
          subject?: string
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaign_templates_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_templates_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_templates_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_templates_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_templates_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_templates_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_templates_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      email_campaigns: {
        Row: {
          academy_profile_id: string | null
          body_html: string
          created_at: string
          failed_count: number
          filters: Json | null
          id: string
          sent_at: string | null
          sent_count: number
          status: string
          subject: string
          template_id: string | null
          total_recipients: number
          trainer_profile_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id?: string | null
          body_html: string
          created_at?: string
          failed_count?: number
          filters?: Json | null
          id?: string
          sent_at?: string | null
          sent_count?: number
          status?: string
          subject: string
          template_id?: string | null
          total_recipients?: number
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string | null
          body_html?: string
          created_at?: string
          failed_count?: number
          filters?: Json | null
          id?: string
          sent_at?: string | null
          sent_count?: number
          status?: string
          subject?: string
          template_id?: string | null
          total_recipients?: number
          trainer_profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaigns_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "email_campaign_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaigns_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      email_delivery_events: {
        Row: {
          academy_profile_id: string | null
          bounce_type: string | null
          created_at: string
          event_type: string
          id: string
          invoice_id: string | null
          occurred_at: string
          reason: string | null
          recipient_email: string
          resend_email_id: string | null
          resend_event_id: string | null
          trainer_id: string | null
        }
        Insert: {
          academy_profile_id?: string | null
          bounce_type?: string | null
          created_at?: string
          event_type: string
          id?: string
          invoice_id?: string | null
          occurred_at?: string
          reason?: string | null
          recipient_email: string
          resend_email_id?: string | null
          resend_event_id?: string | null
          trainer_id?: string | null
        }
        Update: {
          academy_profile_id?: string | null
          bounce_type?: string | null
          created_at?: string
          event_type?: string
          id?: string
          invoice_id?: string | null
          occurred_at?: string
          reason?: string | null
          recipient_email?: string
          resend_email_id?: string | null
          resend_event_id?: string | null
          trainer_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_delivery_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          academy_profile_id: string | null
          amount: number
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          expense_date: string
          id: string
          trainer_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id?: string | null
          amount: number
          category: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expense_date: string
          id?: string
          trainer_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string | null
          amount?: number
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          expense_date?: string
          id?: string
          trainer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "expenses_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      extra_cost_presets: {
        Row: {
          academy_profile_id: string | null
          created_at: string | null
          description: string
          id: string
          price: number
          trainer_id: string | null
          type: string
          vat_rate: number
        }
        Insert: {
          academy_profile_id?: string | null
          created_at?: string | null
          description: string
          id?: string
          price?: number
          trainer_id?: string | null
          type?: string
          vat_rate?: number
        }
        Update: {
          academy_profile_id?: string | null
          created_at?: string | null
          description?: string
          id?: string
          price?: number
          trainer_id?: string | null
          type?: string
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "extra_cost_presets_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extra_cost_presets_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extra_cost_presets_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extra_cost_presets_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extra_cost_presets_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extra_cost_presets_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "extra_cost_presets_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_players: {
        Row: {
          academy_profile_id: string | null
          billing_address: string | null
          billing_btw_number: string | null
          billing_business_name: string | null
          birth_date: string | null
          created_at: string
          email: string | null
          first_name: string | null
          full_name: string
          has_trained: boolean
          id: string
          last_name: string | null
          linked_profile_id: string | null
          notes: string | null
          phone: string | null
          preferred_location_id: string | null
          rating_system: string
          skill_rating: number | null
          source: string | null
          trainer_id: string | null
          updated_at: string
        }
        Insert: {
          academy_profile_id?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          birth_date?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          full_name: string
          has_trained?: boolean
          id?: string
          last_name?: string | null
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string | null
          preferred_location_id?: string | null
          rating_system?: string
          skill_rating?: number | null
          source?: string | null
          trainer_id?: string | null
          updated_at?: string
        }
        Update: {
          academy_profile_id?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          birth_date?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          full_name?: string
          has_trained?: boolean
          id?: string
          last_name?: string | null
          linked_profile_id?: string | null
          notes?: string | null
          phone?: string | null
          preferred_location_id?: string | null
          rating_system?: string
          skill_rating?: number | null
          source?: string | null
          trainer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "guest_players_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guest_players_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profiles_owner"
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
            foreignKeyName: "guest_players_preferred_location_id_fkey"
            columns: ["preferred_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
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
            referencedRelation: "trainer_profiles_owner"
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
          birth_date: string | null
          consent_given: boolean
          created_at: string
          cycle_id: string | null
          email: string
          full_name: string
          guest_player_id: string | null
          id: string
          invoice_id: string | null
          lesson_type: string[]
          location_id: string | null
          metadata: Json | null
          notes: string | null
          payment_method: string | null
          phone: string | null
          player_id: string | null
          preferred_days: string[]
          preferred_duration_minutes: number | null
          preferred_time_windows: Json
          preferred_trainer_ids: string[] | null
          rating: number | null
          rating_system: string | null
          registration_id: string
          sessions_per_week: number | null
          skip_reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          birth_date?: string | null
          consent_given?: boolean
          created_at?: string
          cycle_id?: string | null
          email: string
          full_name: string
          guest_player_id?: string | null
          id?: string
          invoice_id?: string | null
          lesson_type: string[]
          location_id?: string | null
          metadata?: Json | null
          notes?: string | null
          payment_method?: string | null
          phone?: string | null
          player_id?: string | null
          preferred_days: string[]
          preferred_duration_minutes?: number | null
          preferred_time_windows: Json
          preferred_trainer_ids?: string[] | null
          rating?: number | null
          rating_system?: string | null
          registration_id: string
          sessions_per_week?: number | null
          skip_reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          birth_date?: string | null
          consent_given?: boolean
          created_at?: string
          cycle_id?: string | null
          email?: string
          full_name?: string
          guest_player_id?: string | null
          id?: string
          invoice_id?: string | null
          lesson_type?: string[]
          location_id?: string | null
          metadata?: Json | null
          notes?: string | null
          payment_method?: string | null
          phone?: string | null
          player_id?: string | null
          preferred_days?: string[]
          preferred_duration_minutes?: number | null
          preferred_time_windows?: Json
          preferred_trainer_ids?: string[] | null
          rating?: number | null
          rating_system?: string | null
          registration_id?: string
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
            foreignKeyName: "intake_requests_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "cycles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_requests_guest_player_id_fkey"
            columns: ["guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "intake_requests_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
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
            referencedRelation: "profiles_owner"
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
          {
            foreignKeyName: "intake_requests_registration_id_fkey"
            columns: ["registration_id"]
            isOneToOne: false
            referencedRelation: "registrations"
            referencedColumns: ["id"]
          },
        ]
      }
      internal_links: {
        Row: {
          anchor_text: string
          from_slug: string
          id: string
          locale: string
          to_slug: string
        }
        Insert: {
          anchor_text: string
          from_slug: string
          id?: string
          locale: string
          to_slug: string
        }
        Update: {
          anchor_text?: string
          from_slug?: string
          id?: string
          locale?: string
          to_slug?: string
        }
        Relationships: []
      }
      invoice_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          id: string
          invoice_id: string
          new_status: string | null
          old_status: string | null
          reason: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          invoice_id: string
          new_status?: string | null
          old_status?: string | null
          reason?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          invoice_id?: string
          new_status?: string | null
          old_status?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_status_history_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          academy_profile_id: string | null
          booking_ids: string[] | null
          created_at: string
          cycle_id: string | null
          due_date: string
          forwarded_at: string | null
          guest_player_id: string | null
          id: string
          invoice_date: string
          invoice_number: string
          line_items: Json
          mollie_payment_id: string | null
          mollie_payment_url: string | null
          notes: string | null
          paid_at: string | null
          pdf_url: string | null
          player_address: string | null
          player_btw_number: string | null
          player_business_name: string | null
          player_id: string | null
          player_name: string
          prices_include_vat: boolean
          public_token: string
          public_token_revoked_at: string | null
          rebook_cyclus_id: string | null
          rebook_group_id: string | null
          registration_id: string | null
          sent_at: string | null
          split_count: number | null
          status: string
          subtotal: number
          total: number
          trainer_id: string | null
          updated_at: string
          vat_amount: number
          vat_breakdown: Json | null
          vat_rate: number
        }
        Insert: {
          academy_profile_id?: string | null
          booking_ids?: string[] | null
          created_at?: string
          cycle_id?: string | null
          due_date: string
          forwarded_at?: string | null
          guest_player_id?: string | null
          id?: string
          invoice_date?: string
          invoice_number: string
          line_items?: Json
          mollie_payment_id?: string | null
          mollie_payment_url?: string | null
          notes?: string | null
          paid_at?: string | null
          pdf_url?: string | null
          player_address?: string | null
          player_btw_number?: string | null
          player_business_name?: string | null
          player_id?: string | null
          player_name: string
          prices_include_vat?: boolean
          public_token?: string
          public_token_revoked_at?: string | null
          rebook_cyclus_id?: string | null
          rebook_group_id?: string | null
          registration_id?: string | null
          sent_at?: string | null
          split_count?: number | null
          status?: string
          subtotal?: number
          total?: number
          trainer_id?: string | null
          updated_at?: string
          vat_amount?: number
          vat_breakdown?: Json | null
          vat_rate?: number
        }
        Update: {
          academy_profile_id?: string | null
          booking_ids?: string[] | null
          created_at?: string
          cycle_id?: string | null
          due_date?: string
          forwarded_at?: string | null
          guest_player_id?: string | null
          id?: string
          invoice_date?: string
          invoice_number?: string
          line_items?: Json
          mollie_payment_id?: string | null
          mollie_payment_url?: string | null
          notes?: string | null
          paid_at?: string | null
          pdf_url?: string | null
          player_address?: string | null
          player_btw_number?: string | null
          player_business_name?: string | null
          player_id?: string | null
          player_name?: string
          prices_include_vat?: boolean
          public_token?: string
          public_token_revoked_at?: string | null
          rebook_cyclus_id?: string | null
          rebook_group_id?: string | null
          registration_id?: string | null
          sent_at?: string | null
          split_count?: number | null
          status?: string
          subtotal?: number
          total?: number
          trainer_id?: string | null
          updated_at?: string
          vat_amount?: number
          vat_breakdown?: Json | null
          vat_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_academy_profile_id_fkey"
            columns: ["academy_profile_id"]
            isOneToOne: false
            referencedRelation: "academy_profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "cycles_public"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "profiles_owner"
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
            foreignKeyName: "invoices_registration_id_fkey"
            columns: ["registration_id"]
            isOneToOne: false
            referencedRelation: "registrations"
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
            referencedRelation: "trainer_profiles_owner"
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
      lessons: {
        Row: {
          booking_mode: string
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
          booking_mode?: string
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
          booking_mode?: string
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
          {
            foreignKeyName: "lessons_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_trainer_id_fkey"
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
      location_translations: {
        Row: {
          created_at: string
          description: string | null
          id: string
          locale: string
          location_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          locale: string
          location_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          locale?: string
          location_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_translations_location_id_fkey"
            columns: ["location_id"]
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
          enrichment_error_msg: string | null
          enrichment_failed_at: string | null
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
          merged_into: string | null
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
          enrichment_error_msg?: string | null
          enrichment_failed_at?: string | null
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
          merged_into?: string | null
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
          enrichment_error_msg?: string | null
          enrichment_failed_at?: string | null
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
          merged_into?: string | null
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
        Relationships: [
          {
            foreignKeyName: "locations_merged_into_fkey"
            columns: ["merged_into"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      mollie_oauth_states: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          expires_at: string
          state: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          expires_at?: string
          state: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          expires_at?: string
          state?: string
          used_at?: string | null
          user_id?: string
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
      notification_sends: {
        Row: {
          created_at: string
          dedup_key: string
          id: string
        }
        Insert: {
          created_at?: string
          dedup_key: string
          id?: string
        }
        Update: {
          created_at?: string
          dedup_key?: string
          id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string
          created_at: string | null
          data: Json | null
          id: string
          read: boolean | null
          title: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string | null
          data?: Json | null
          id?: string
          read?: boolean | null
          title: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string | null
          data?: Json | null
          id?: string
          read?: boolean | null
          title?: string
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
          budget_cap: number | null
          budget_type: Database["public"]["Enums"]["banner_budget_type"]
          click_count: number
          club_profile_id: string | null
          created_at: string
          display_order: number
          end_date: string | null
          format: Database["public"]["Enums"]["banner_format"]
          id: string
          image_url: string
          impression_count: number
          is_active: boolean
          link_url: string | null
          location_id: string | null
          name: string
          sponsor_logo_url: string | null
          sponsor_name: string | null
          start_date: string | null
          updated_at: string
        }
        Insert: {
          budget_cap?: number | null
          budget_type?: Database["public"]["Enums"]["banner_budget_type"]
          click_count?: number
          club_profile_id?: string | null
          created_at?: string
          display_order?: number
          end_date?: string | null
          format?: Database["public"]["Enums"]["banner_format"]
          id?: string
          image_url: string
          impression_count?: number
          is_active?: boolean
          link_url?: string | null
          location_id?: string | null
          name: string
          sponsor_logo_url?: string | null
          sponsor_name?: string | null
          start_date?: string | null
          updated_at?: string
        }
        Update: {
          budget_cap?: number | null
          budget_type?: Database["public"]["Enums"]["banner_budget_type"]
          click_count?: number
          club_profile_id?: string | null
          created_at?: string
          display_order?: number
          end_date?: string | null
          format?: Database["public"]["Enums"]["banner_format"]
          id?: string
          image_url?: string
          impression_count?: number
          is_active?: boolean
          link_url?: string | null
          location_id?: string | null
          name?: string
          sponsor_logo_url?: string | null
          sponsor_name?: string | null
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
            referencedRelation: "club_profiles_owner"
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
      payment_audit_log: {
        Row: {
          amount: number | null
          booking_id: string | null
          created_at: string
          currency: string | null
          error_message: string | null
          function_name: string
          id: string
          invoice_id: string | null
          metadata: Json | null
          mollie_org_id: string | null
          mollie_payment_id: string | null
          recipient_type: string | null
          status: string
        }
        Insert: {
          amount?: number | null
          booking_id?: string | null
          created_at?: string
          currency?: string | null
          error_message?: string | null
          function_name: string
          id?: string
          invoice_id?: string | null
          metadata?: Json | null
          mollie_org_id?: string | null
          mollie_payment_id?: string | null
          recipient_type?: string | null
          status: string
        }
        Update: {
          amount?: number | null
          booking_id?: string | null
          created_at?: string
          currency?: string | null
          error_message?: string | null
          function_name?: string
          id?: string
          invoice_id?: string | null
          metadata?: Json | null
          mollie_org_id?: string | null
          mollie_payment_id?: string | null
          recipient_type?: string | null
          status?: string
        }
        Relationships: []
      }
      player_links: {
        Row: {
          created_at: string
          id: string
          intake_request_id: string
          link_group: string
        }
        Insert: {
          created_at?: string
          id?: string
          intake_request_id: string
          link_group?: string
        }
        Update: {
          created_at?: string
          id?: string
          intake_request_id?: string
          link_group?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_links_intake_request_id_fkey"
            columns: ["intake_request_id"]
            isOneToOne: true
            referencedRelation: "intake_requests"
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
          birth_date: string | null
          created_at: string
          email: string | null
          first_name: string | null
          full_name: string | null
          id: string
          last_name: string | null
          location: string | null
          phone: string | null
          preferred_language: string | null
          rating_member_id: string | null
          rating_system: string
          skill_rating: number | null
          stripe_customer_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          bio?: string | null
          birth_date?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          location?: string | null
          phone?: string | null
          preferred_language?: string | null
          rating_member_id?: string | null
          rating_system?: string
          skill_rating?: number | null
          stripe_customer_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          bio?: string | null
          birth_date?: string | null
          created_at?: string
          email?: string | null
          first_name?: string | null
          full_name?: string | null
          id?: string
          last_name?: string | null
          location?: string | null
          phone?: string | null
          preferred_language?: string | null
          rating_member_id?: string | null
          rating_system?: string
          skill_rating?: number | null
          stripe_customer_id?: string | null
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
            referencedRelation: "trainer_profiles_owner"
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
      registrations: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          format: string
          id: string
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_table: Json | null
          settings: Json
          source_cycle_id: string | null
          start_date: string | null
          status: string
          terms: string | null
          total_price: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          end_date?: string | null
          enrollment_deadline?: string | null
          format?: string
          id?: string
          location_id?: string | null
          name: string
          owner_id: string
          owner_type: string
          price_table?: Json | null
          settings?: Json
          source_cycle_id?: string | null
          start_date?: string | null
          status?: string
          terms?: string | null
          total_price?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          end_date?: string | null
          enrollment_deadline?: string | null
          format?: string
          id?: string
          location_id?: string | null
          name?: string
          owner_id?: string
          owner_type?: string
          price_table?: Json | null
          settings?: Json
          source_cycle_id?: string | null
          start_date?: string | null
          status?: string
          terms?: string | null
          total_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "registrations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
      session_player_notes: {
        Row: {
          author_id: string
          author_role: string
          body: string
          created_at: string
          id: string
          media: Json | null
          slot_id: string
          subject_guest_player_id: string | null
          subject_profile_id: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
          author_id: string
          author_role: string
          body: string
          created_at?: string
          id?: string
          media?: Json | null
          slot_id: string
          subject_guest_player_id?: string | null
          subject_profile_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
          author_id?: string
          author_role?: string
          body?: string
          created_at?: string
          id?: string
          media?: Json | null
          slot_id?: string
          subject_guest_player_id?: string | null
          subject_profile_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_player_notes_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_player_notes_subject_guest_player_id_fkey"
            columns: ["subject_guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_player_notes_subject_profile_id_fkey"
            columns: ["subject_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_player_notes_subject_profile_id_fkey"
            columns: ["subject_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_player_notes_subject_profile_id_fkey"
            columns: ["subject_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_player_notes_subject_profile_id_fkey"
            columns: ["subject_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      session_reports: {
        Row: {
          attendees: string[] | null
          created_at: string | null
          id: string
          notes: string | null
          public_notes: string | null
          reporter_id: string
          reporter_role: string
          session_happened: boolean
          slot_id: string
          updated_at: string | null
        }
        Insert: {
          attendees?: string[] | null
          created_at?: string | null
          id?: string
          notes?: string | null
          public_notes?: string | null
          reporter_id: string
          reporter_role: string
          session_happened?: boolean
          slot_id: string
          updated_at?: string | null
        }
        Update: {
          attendees?: string[] | null
          created_at?: string | null
          id?: string
          notes?: string | null
          public_notes?: string | null
          reporter_id?: string
          reporter_role?: string
          session_happened?: boolean
          slot_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_reports_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      short_links: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          permanent: boolean
          target_id: string | null
          target_params: Json
          target_path: string
          target_type: string
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          permanent?: boolean
          target_id?: string | null
          target_params?: Json
          target_path: string
          target_type: string
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          permanent?: boolean
          target_id?: string | null
          target_params?: Json
          target_path?: string
          target_type?: string
        }
        Relationships: []
      }
      slot_priority_claims: {
        Row: {
          booked_by_guest_player_id: string | null
          booked_by_player_id: string | null
          booking_id: string | null
          claim_token: string
          confirmation_sent_at: string | null
          created_at: string
          decline_reason: string | null
          guest_player_id: string | null
          id: string
          invited_at: string | null
          player_id: string | null
          rebook_group_id: string | null
          reminded_at: string | null
          reminder_count: number
          responded_at: string | null
          response_intent: string | null
          response_intent_at: string | null
          rules_accepted_at: string | null
          slot_id: string
          source_slot_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          booked_by_guest_player_id?: string | null
          booked_by_player_id?: string | null
          booking_id?: string | null
          claim_token?: string
          confirmation_sent_at?: string | null
          created_at?: string
          decline_reason?: string | null
          guest_player_id?: string | null
          id?: string
          invited_at?: string | null
          player_id?: string | null
          rebook_group_id?: string | null
          reminded_at?: string | null
          reminder_count?: number
          responded_at?: string | null
          response_intent?: string | null
          response_intent_at?: string | null
          rules_accepted_at?: string | null
          slot_id: string
          source_slot_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          booked_by_guest_player_id?: string | null
          booked_by_player_id?: string | null
          booking_id?: string | null
          claim_token?: string
          confirmation_sent_at?: string | null
          created_at?: string
          decline_reason?: string | null
          guest_player_id?: string | null
          id?: string
          invited_at?: string | null
          player_id?: string | null
          rebook_group_id?: string | null
          reminded_at?: string | null
          reminder_count?: number
          responded_at?: string | null
          response_intent?: string | null
          response_intent_at?: string | null
          rules_accepted_at?: string | null
          slot_id?: string
          source_slot_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slot_priority_claims_booked_by_guest_player_id_fkey"
            columns: ["booked_by_guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_booked_by_player_id_fkey"
            columns: ["booked_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_booked_by_player_id_fkey"
            columns: ["booked_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_booked_by_player_id_fkey"
            columns: ["booked_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_booked_by_player_id_fkey"
            columns: ["booked_by_player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_guest_player_id_fkey"
            columns: ["guest_player_id"]
            isOneToOne: false
            referencedRelation: "guest_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "profiles_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_priority_claims_source_slot_id_fkey"
            columns: ["source_slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      slug_redirects: {
        Row: {
          created_at: string
          old_slug: string
          owner_id: string
          owner_type: string
        }
        Insert: {
          created_at?: string
          old_slug: string
          owner_id: string
          owner_type: string
        }
        Update: {
          created_at?: string
          old_slug?: string
          owner_id?: string
          owner_type?: string
        }
        Relationships: []
      }
      sources: {
        Row: {
          allowed_to_use: boolean
          article_id: string
          id: string
          notes: string | null
          retrieved_at: string
          source_title: string | null
          source_url: string
        }
        Insert: {
          allowed_to_use?: boolean
          article_id: string
          id?: string
          notes?: string | null
          retrieved_at?: string
          source_title?: string | null
          source_url: string
        }
        Update: {
          allowed_to_use?: boolean
          article_id?: string
          id?: string
          notes?: string | null
          retrieved_at?: string
          source_title?: string | null
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "sources_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
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
      stripe_webhook_events: {
        Row: {
          event_created: number | null
          event_id: string
          event_type: string
          processed_at: string
          subscription_id: string | null
        }
        Insert: {
          event_created?: number | null
          event_id: string
          event_type: string
          processed_at?: string
          subscription_id?: string | null
        }
        Update: {
          event_created?: number | null
          event_id?: string
          event_type?: string
          processed_at?: string
          subscription_id?: string | null
        }
        Relationships: []
      }
      subscription_payments: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          mollie_customer_id: string | null
          mollie_payment_id: string
          mollie_subscription_id: string | null
          paid_at: string | null
          plan_id: string | null
          profile_id: string
          profile_type: string
          status: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          mollie_customer_id?: string | null
          mollie_payment_id: string
          mollie_subscription_id?: string | null
          paid_at?: string | null
          plan_id?: string | null
          profile_id: string
          profile_type: string
          status: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          mollie_customer_id?: string | null
          mollie_payment_id?: string
          mollie_subscription_id?: string | null
          paid_at?: string | null
          plan_id?: string | null
          profile_id?: string
          profile_type?: string
          status?: string
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
          monthly_price: number
          name: string
          plan_type: string
          platform_fee_flat: number | null
          platform_fee_percent: number
          stripe_price_id_monthly: string | null
          stripe_price_id_yearly: string | null
          stripe_product_id_monthly: string | null
          stripe_product_id_yearly: string | null
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
          monthly_price?: number
          name: string
          plan_type?: string
          platform_fee_flat?: number | null
          platform_fee_percent?: number
          stripe_price_id_monthly?: string | null
          stripe_price_id_yearly?: string | null
          stripe_product_id_monthly?: string | null
          stripe_product_id_yearly?: string | null
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
          monthly_price?: number
          name?: string
          plan_type?: string
          platform_fee_flat?: number | null
          platform_fee_percent?: number
          stripe_price_id_monthly?: string | null
          stripe_price_id_yearly?: string | null
          stripe_product_id_monthly?: string | null
          stripe_product_id_yearly?: string | null
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
          token_refreshing_at: string | null
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
          token_refreshing_at?: string | null
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
          token_refreshing_at?: string | null
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
            referencedRelation: "trainer_profiles_owner"
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
      trainer_onboarding_responses: {
        Row: {
          admin_hours_per_week: string | null
          completed_at: string | null
          created_at: string
          critical_event_note: string | null
          decision_criteria: string[] | null
          decision_makers: string[] | null
          lessons_per_week_range: string | null
          player_count_range: string | null
          previous_tools: string[] | null
          primary_city: string | null
          primary_pains: string[] | null
          target_live_date: string | null
          target_live_window: string | null
          trainer_profile_id: string
          trainer_type: string | null
          updated_at: string
        }
        Insert: {
          admin_hours_per_week?: string | null
          completed_at?: string | null
          created_at?: string
          critical_event_note?: string | null
          decision_criteria?: string[] | null
          decision_makers?: string[] | null
          lessons_per_week_range?: string | null
          player_count_range?: string | null
          previous_tools?: string[] | null
          primary_city?: string | null
          primary_pains?: string[] | null
          target_live_date?: string | null
          target_live_window?: string | null
          trainer_profile_id: string
          trainer_type?: string | null
          updated_at?: string
        }
        Update: {
          admin_hours_per_week?: string | null
          completed_at?: string | null
          created_at?: string
          critical_event_note?: string | null
          decision_criteria?: string[] | null
          decision_makers?: string[] | null
          lessons_per_week_range?: string | null
          player_count_range?: string | null
          previous_tools?: string[] | null
          primary_city?: string | null
          primary_pains?: string[] | null
          target_live_date?: string | null
          target_live_window?: string | null
          trainer_profile_id?: string
          trainer_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_onboarding_responses_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_onboarding_responses_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles_owner"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_onboarding_responses_trainer_profile_id_fkey"
            columns: ["trainer_profile_id"]
            isOneToOne: true
            referencedRelation: "trainer_profiles_safe"
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
          {
            foreignKeyName: "trainer_profile_views_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainer_profiles_owner"
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
          anonymized_at: string | null
          banner_url: string | null
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
          invoice_banner_color: string | null
          invoice_forward_emails: string[] | null
          invoice_include_year: boolean
          invoice_language: string
          invoice_logo_url: string | null
          invoice_next_number: number | null
          invoice_prefix: string | null
          invoice_reply_to_email: string | null
          is_public: boolean | null
          is_verified: boolean | null
          knltb_rating: number | null
          kvk_number: string | null
          last_processed_payment_id: string | null
          mollie_customer_id: string | null
          payment_terms_days: number | null
          platform_fee_override: number | null
          preferred_max_rating: number | null
          preferred_min_rating: number | null
          preferred_rating_system: string | null
          prices_include_vat: boolean
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
          stripe_account_id: string | null
          stripe_customer_id: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          timezone: string
          trainer_rating_system: string | null
          trial_ends_at: string | null
          trial_started_at: string | null
          updated_at: string
          use_manual_invoicing: boolean | null
          user_id: string
          video_url: string | null
          waiting_list_enabled: boolean
          website_url: string | null
          welcome_message: string | null
        }
        Insert: {
          anonymized_at?: string | null
          banner_url?: string | null
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
          invoice_banner_color?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean
          invoice_language?: string
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          mollie_customer_id?: string | null
          payment_terms_days?: number | null
          platform_fee_override?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          prices_include_vat?: boolean
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
          stripe_account_id?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          use_manual_invoicing?: boolean | null
          user_id: string
          video_url?: string | null
          waiting_list_enabled?: boolean
          website_url?: string | null
          welcome_message?: string | null
        }
        Update: {
          anonymized_at?: string | null
          banner_url?: string | null
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
          invoice_banner_color?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean
          invoice_language?: string
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          mollie_customer_id?: string | null
          payment_terms_days?: number | null
          platform_fee_override?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          prices_include_vat?: boolean
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
          stripe_account_id?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          use_manual_invoicing?: boolean | null
          user_id?: string
          video_url?: string | null
          waiting_list_enabled?: boolean
          website_url?: string | null
          welcome_message?: string | null
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
            referencedRelation: "trainer_profiles_owner"
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
      user_discounts: {
        Row: {
          created_at: string
          created_by: string | null
          discount_percent: number
          duration_months: number
          first_payment_at: string | null
          id: string
          is_active: boolean
          months_remaining: number
          source: string
          stripe_coupon_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          discount_percent: number
          duration_months: number
          first_payment_at?: string | null
          id?: string
          is_active?: boolean
          months_remaining: number
          source?: string
          stripe_coupon_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          discount_percent?: number
          duration_months?: number
          first_payment_at?: string | null
          id?: string
          is_active?: boolean
          months_remaining?: number
          source?: string
          stripe_coupon_id?: string | null
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
            referencedRelation: "profiles_owner"
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
            referencedRelation: "academy_profiles_owner"
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
      academy_profiles_owner: {
        Row: {
          banner_url: string | null
          bic: string | null
          btw_number: string | null
          business_address: string | null
          business_name: string | null
          contact_email: string | null
          country: string | null
          created_at: string | null
          created_by: string | null
          default_vat_rate: number | null
          description: string | null
          general_terms: string | null
          iban: string | null
          id: string | null
          invoice_banner_color: string | null
          invoice_forward_emails: string[] | null
          invoice_include_year: boolean | null
          invoice_language: string | null
          invoice_logo_url: string | null
          invoice_next_number: number | null
          invoice_prefix: string | null
          invoice_reply_to_email: string | null
          is_public: boolean | null
          is_verified: boolean | null
          kvk_number: string | null
          last_processed_payment_id: string | null
          logo_url: string | null
          mollie_customer_id: string | null
          name: string | null
          payment_terms_days: number | null
          phone: string | null
          platform_fee_override: number | null
          slug: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          stripe_customer_id: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          timezone: string | null
          trial_ends_at: string | null
          updated_at: string | null
          waiting_list_enabled: boolean | null
          warning_max_age_diff_years: number | null
          warning_max_rating_spread: number | null
          website_url: string | null
          welcome_message: string | null
        }
        Insert: {
          banner_url?: string | null
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          contact_email?: string | null
          country?: string | null
          created_at?: string | null
          created_by?: string | null
          default_vat_rate?: number | null
          description?: string | null
          general_terms?: string | null
          iban?: string | null
          id?: string | null
          invoice_banner_color?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean | null
          invoice_language?: string | null
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          logo_url?: string | null
          mollie_customer_id?: string | null
          name?: string | null
          payment_terms_days?: number | null
          phone?: string | null
          platform_fee_override?: number | null
          slug?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          waiting_list_enabled?: boolean | null
          warning_max_age_diff_years?: number | null
          warning_max_rating_spread?: number | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Update: {
          banner_url?: string | null
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          contact_email?: string | null
          country?: string | null
          created_at?: string | null
          created_by?: string | null
          default_vat_rate?: number | null
          description?: string | null
          general_terms?: string | null
          iban?: string | null
          id?: string | null
          invoice_banner_color?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean | null
          invoice_language?: string | null
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          logo_url?: string | null
          mollie_customer_id?: string | null
          name?: string | null
          payment_terms_days?: number | null
          phone?: string | null
          platform_fee_override?: number | null
          slug?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          waiting_list_enabled?: boolean | null
          warning_max_age_diff_years?: number | null
          warning_max_rating_spread?: number | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Relationships: []
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
          country: string | null
          created_at: string | null
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
          timezone: string | null
          updated_at: string | null
          waiting_list_enabled: boolean | null
          website_url: string | null
          welcome_message: string | null
        }
        Insert: {
          banner_url?: string | null
          country?: string | null
          created_at?: string | null
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
          timezone?: string | null
          updated_at?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Update: {
          banner_url?: string | null
          country?: string | null
          created_at?: string | null
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
          timezone?: string | null
          updated_at?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Relationships: []
      }
      academy_trainers_owner: {
        Row: {
          academy_profile_id: string | null
          created_at: string | null
          id: string | null
          invited_by: string | null
          joined_at: string | null
          payment_percentage: number | null
          show_on_academy_page: boolean | null
          status: string | null
          trainer_profile_id: string | null
          updated_at: string | null
        }
        Insert: {
          academy_profile_id?: string | null
          created_at?: string | null
          id?: string | null
          invited_by?: string | null
          joined_at?: string | null
          payment_percentage?: number | null
          show_on_academy_page?: boolean | null
          status?: string | null
          trainer_profile_id?: string | null
          updated_at?: string | null
        }
        Update: {
          academy_profile_id?: string | null
          created_at?: string | null
          id?: string | null
          invited_by?: string | null
          joined_at?: string | null
          payment_percentage?: number | null
          show_on_academy_page?: boolean | null
          status?: string | null
          trainer_profile_id?: string | null
          updated_at?: string | null
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
      academy_trainers_public: {
        Row: {
          academy_profile_id: string | null
          created_at: string | null
          id: string | null
          joined_at: string | null
          show_on_academy_page: boolean | null
          status: string | null
          trainer_profile_id: string | null
          updated_at: string | null
        }
        Insert: {
          academy_profile_id?: string | null
          created_at?: string | null
          id?: string | null
          joined_at?: string | null
          show_on_academy_page?: boolean | null
          status?: string | null
          trainer_profile_id?: string | null
          updated_at?: string | null
        }
        Update: {
          academy_profile_id?: string | null
          created_at?: string | null
          id?: string | null
          joined_at?: string | null
          show_on_academy_page?: boolean | null
          status?: string | null
          trainer_profile_id?: string | null
          updated_at?: string | null
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
            referencedRelation: "academy_profiles_owner"
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
            referencedRelation: "trainer_profiles_owner"
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
      club_profiles_owner: {
        Row: {
          banner_url: string | null
          claimed_at: string | null
          contact_email: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string | null
          is_verified: boolean | null
          last_processed_payment_id: string | null
          location_id: string | null
          logo_url: string | null
          mollie_customer_id: string | null
          phone: string | null
          social_facebook: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          stripe_customer_id: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          trial_ends_at: string | null
          updated_at: string | null
          welcome_message: string | null
        }
        Insert: {
          banner_url?: string | null
          claimed_at?: string | null
          contact_email?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string | null
          is_verified?: boolean | null
          last_processed_payment_id?: string | null
          location_id?: string | null
          logo_url?: string | null
          mollie_customer_id?: string | null
          phone?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          welcome_message?: string | null
        }
        Update: {
          banner_url?: string | null
          claimed_at?: string | null
          contact_email?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string | null
          is_verified?: boolean | null
          last_processed_payment_id?: string | null
          location_id?: string | null
          logo_url?: string | null
          mollie_customer_id?: string | null
          phone?: string | null
          social_facebook?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          trial_ends_at?: string | null
          updated_at?: string | null
          welcome_message?: string | null
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
          welcome_message: string | null
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
          welcome_message?: string | null
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
          welcome_message?: string | null
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
      cycles_public: {
        Row: {
          created_at: string | null
          currency: string | null
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          id: string | null
          is_always_open: boolean | null
          location_id: string | null
          name: string | null
          owner_id: string | null
          owner_type: string | null
          price_per_session: number | null
          price_table: Json | null
          settings: Json | null
          start_date: string | null
          status: string | null
          terms: string | null
          total_price: number | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          currency?: string | null
          description?: string | null
          end_date?: string | null
          enrollment_deadline?: string | null
          id?: string | null
          is_always_open?: boolean | null
          location_id?: string | null
          name?: string | null
          owner_id?: string | null
          owner_type?: string | null
          price_per_session?: number | null
          price_table?: Json | null
          settings?: never
          start_date?: string | null
          status?: string | null
          terms?: string | null
          total_price?: number | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          currency?: string | null
          description?: string | null
          end_date?: string | null
          enrollment_deadline?: string | null
          id?: string | null
          is_always_open?: boolean | null
          location_id?: string | null
          name?: string | null
          owner_id?: string | null
          owner_type?: string | null
          price_per_session?: number | null
          price_table?: Json | null
          settings?: never
          start_date?: string | null
          status?: string | null
          terms?: string | null
          total_price?: number | null
          type?: string | null
          updated_at?: string | null
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
      profiles_owner: {
        Row: {
          avatar_url: string | null
          billing_address: string | null
          billing_btw_number: string | null
          billing_business_name: string | null
          bio: string | null
          birth_date: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string | null
          location: string | null
          phone: string | null
          preferred_language: string | null
          rating_member_id: string | null
          rating_system: string | null
          skill_rating: number | null
          stripe_customer_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          bio?: string | null
          birth_date?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string | null
          location?: string | null
          phone?: string | null
          preferred_language?: string | null
          rating_member_id?: string | null
          rating_system?: string | null
          skill_rating?: number | null
          stripe_customer_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          billing_address?: string | null
          billing_btw_number?: string | null
          billing_business_name?: string | null
          bio?: string | null
          birth_date?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string | null
          location?: string | null
          phone?: string | null
          preferred_language?: string | null
          rating_member_id?: string | null
          rating_system?: string | null
          skill_rating?: number | null
          stripe_customer_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
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
      session_reports_player_summaries: {
        Row: {
          created_at: string | null
          id: string | null
          public_notes: string | null
          reporter_role: string | null
          session_happened: boolean | null
          slot_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          public_notes?: string | null
          reporter_role?: string | null
          session_happened?: boolean | null
          slot_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          public_notes?: string | null
          reporter_role?: string | null
          session_happened?: boolean | null
          slot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_reports_slot_id_fkey"
            columns: ["slot_id"]
            isOneToOne: false
            referencedRelation: "availability_slots"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_mollie_status: {
        Row: {
          charges_enabled: boolean | null
          is_connected: boolean | null
          trainer_id: string | null
        }
        Insert: {
          charges_enabled?: boolean | null
          is_connected?: never
          trainer_id?: string | null
        }
        Update: {
          charges_enabled?: boolean | null
          is_connected?: never
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
            referencedRelation: "trainer_profiles_owner"
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
      trainer_profiles_owner: {
        Row: {
          bic: string | null
          btw_number: string | null
          business_address: string | null
          business_name: string | null
          certifications: string[] | null
          coaching_method: string | null
          coaching_since_year: number | null
          created_at: string | null
          default_vat_rate: number | null
          experience_years: number | null
          favourite_quote: string | null
          general_terms: string | null
          hourly_rate: number | null
          iban: string | null
          id: string | null
          invoice_banner_color: string | null
          invoice_forward_emails: string[] | null
          invoice_include_year: boolean | null
          invoice_language: string | null
          invoice_logo_url: string | null
          invoice_next_number: number | null
          invoice_prefix: string | null
          invoice_reply_to_email: string | null
          is_public: boolean | null
          is_verified: boolean | null
          knltb_rating: number | null
          kvk_number: string | null
          last_processed_payment_id: string | null
          mollie_customer_id: string | null
          payment_terms_days: number | null
          platform_fee_override: number | null
          preferred_max_rating: number | null
          preferred_min_rating: number | null
          preferred_rating_system: string | null
          prices_include_vat: boolean | null
          require_booking_approval: boolean | null
          schedule_weeks_ahead: number | null
          slot_duration_minutes: number | null
          slot_gap_minutes: number | null
          slug: string | null
          social_instagram: string | null
          social_linkedin: string | null
          social_tiktok: string | null
          social_youtube: string | null
          specializations: string[] | null
          stripe_account_id: string | null
          stripe_customer_id: string | null
          subscription_ends_at: string | null
          subscription_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          timezone: string | null
          trainer_rating_system: string | null
          trial_ends_at: string | null
          trial_started_at: string | null
          updated_at: string | null
          use_manual_invoicing: boolean | null
          user_id: string | null
          video_url: string | null
          waiting_list_enabled: boolean | null
          website_url: string | null
          welcome_message: string | null
        }
        Insert: {
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          certifications?: string[] | null
          coaching_method?: string | null
          coaching_since_year?: number | null
          created_at?: string | null
          default_vat_rate?: number | null
          experience_years?: number | null
          favourite_quote?: string | null
          general_terms?: string | null
          hourly_rate?: number | null
          iban?: string | null
          id?: string | null
          invoice_banner_color?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean | null
          invoice_language?: string | null
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          mollie_customer_id?: string | null
          payment_terms_days?: number | null
          platform_fee_override?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          prices_include_vat?: boolean | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number | null
          slot_duration_minutes?: number | null
          slot_gap_minutes?: number | null
          slug?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          specializations?: string[] | null
          stripe_account_id?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string | null
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string | null
          use_manual_invoicing?: boolean | null
          user_id?: string | null
          video_url?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Update: {
          bic?: string | null
          btw_number?: string | null
          business_address?: string | null
          business_name?: string | null
          certifications?: string[] | null
          coaching_method?: string | null
          coaching_since_year?: number | null
          created_at?: string | null
          default_vat_rate?: number | null
          experience_years?: number | null
          favourite_quote?: string | null
          general_terms?: string | null
          hourly_rate?: number | null
          iban?: string | null
          id?: string | null
          invoice_banner_color?: string | null
          invoice_forward_emails?: string[] | null
          invoice_include_year?: boolean | null
          invoice_language?: string | null
          invoice_logo_url?: string | null
          invoice_next_number?: number | null
          invoice_prefix?: string | null
          invoice_reply_to_email?: string | null
          is_public?: boolean | null
          is_verified?: boolean | null
          knltb_rating?: number | null
          kvk_number?: string | null
          last_processed_payment_id?: string | null
          mollie_customer_id?: string | null
          payment_terms_days?: number | null
          platform_fee_override?: number | null
          preferred_max_rating?: number | null
          preferred_min_rating?: number | null
          preferred_rating_system?: string | null
          prices_include_vat?: boolean | null
          require_booking_approval?: boolean | null
          schedule_weeks_ahead?: number | null
          slot_duration_minutes?: number | null
          slot_gap_minutes?: number | null
          slug?: string | null
          social_instagram?: string | null
          social_linkedin?: string | null
          social_tiktok?: string | null
          social_youtube?: string | null
          specializations?: string[] | null
          stripe_account_id?: string | null
          stripe_customer_id?: string | null
          subscription_ends_at?: string | null
          subscription_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          timezone?: string | null
          trainer_rating_system?: string | null
          trial_ends_at?: string | null
          trial_started_at?: string | null
          updated_at?: string | null
          use_manual_invoicing?: boolean | null
          user_id?: string | null
          video_url?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Relationships: []
      }
      trainer_profiles_safe: {
        Row: {
          banner_url: string | null
          certifications: string[] | null
          coaching_method: string | null
          created_at: string | null
          experience_years: number | null
          favourite_quote: string | null
          general_terms: string | null
          hourly_rate: number | null
          id: string | null
          is_active_subscription: boolean | null
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
          trainer_rating_system: string | null
          updated_at: string | null
          use_manual_invoicing: boolean | null
          user_id: string | null
          video_url: string | null
          waiting_list_enabled: boolean | null
          website_url: string | null
          welcome_message: string | null
        }
        Insert: {
          banner_url?: string | null
          certifications?: string[] | null
          coaching_method?: string | null
          created_at?: string | null
          experience_years?: never
          favourite_quote?: string | null
          general_terms?: string | null
          hourly_rate?: number | null
          id?: string | null
          is_active_subscription?: never
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
          trainer_rating_system?: string | null
          updated_at?: string | null
          use_manual_invoicing?: boolean | null
          user_id?: string | null
          video_url?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Update: {
          banner_url?: string | null
          certifications?: string[] | null
          coaching_method?: string | null
          created_at?: string | null
          experience_years?: never
          favourite_quote?: string | null
          general_terms?: string | null
          hourly_rate?: number | null
          id?: string | null
          is_active_subscription?: never
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
          trainer_rating_system?: string | null
          updated_at?: string | null
          use_manual_invoicing?: boolean | null
          user_id?: string | null
          video_url?: string | null
          waiting_list_enabled?: boolean | null
          website_url?: string | null
          welcome_message?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _registration_form_settings: { Args: { p_settings: Json }; Returns: Json }
      _registration_owner_authorized: {
        Args: { p_owner_id: string; p_owner_type: string }
        Returns: boolean
      }
      academy_has_managers: {
        Args: { _academy_profile_id: string }
        Returns: boolean
      }
      accept_rebook_rules: { Args: { _token: string }; Returns: undefined }
      admin_stats_summary: { Args: never; Returns: Json }
      annotate_invoice_status_reason: {
        Args: { p_invoice_id: string; p_reason: string }
        Returns: undefined
      }
      app_now: { Args: never; Returns: string }
      apply_slot_delete_to_cycle: {
        Args: { _cycle_id: string; _slot_ids: string[] }
        Returns: {
          deleted_count: number
          protected_count: number
          protected_slot_ids: string[]
        }[]
      }
      apply_slot_edit_to_cycle: {
        Args: { _cycle_id: string; _patch: Json; _slot_ids: string[] }
        Returns: {
          blocked_count: number
          blocked_slot_ids: string[]
          updated_count: number
        }[]
      }
      book_guest_cart_for_payment: {
        Args: {
          _amounts: number[]
          _guest_player_id: string
          _hold_minutes?: number
          _notes?: string
          _slot_ids: string[]
        }
        Returns: string[]
      }
      book_guest_cyclus_for_payment: {
        Args: {
          _amounts: number[]
          _guest_player_id: string
          _hold_minutes?: number
          _notes?: string
          _slot_ids: string[]
        }
        Returns: string[]
      }
      book_guest_slot_for_payment: {
        Args: {
          _guest_player_id: string
          _hold_minutes?: number
          _notes?: string
          _payment_amount: number
          _slot_id: string
        }
        Returns: string
      }
      book_slot_for_payment: {
        Args: {
          _notes?: string
          _payment_amount: number
          _player_id: string
          _slot_id: string
        }
        Returns: string
      }
      booking_occupies_seat: {
        Args: { p_hold_expires_at: string; p_status: string }
        Returns: boolean
      }
      bump_rebook_reminders: {
        Args: {
          p_guest_ids: string[]
          p_player_ids: string[]
          p_slot_ids: string[]
        }
        Returns: undefined
      }
      can_book_member_window: {
        Args: { _cycle_id: string; _user_id: string }
        Returns: boolean
      }
      can_book_slot: {
        Args: { _slot_id: string; _user_id: string }
        Returns: string
      }
      can_current_user_book_member_window: {
        Args: { _cycle_id: string }
        Returns: boolean
      }
      can_manage_slot: {
        Args: { _slot_id: string; _user_id: string }
        Returns: boolean
      }
      check_enrichment_job_status: { Args: never; Returns: Json }
      check_logo_fetch_job_status: { Args: never; Returns: Json }
      claim_onboarding_email_queue_item: {
        Args: { p_from_status: string; p_queue_id: string }
        Returns: boolean
      }
      claim_rebook_member_open_notice: {
        Args: { _cycle_id: string }
        Returns: boolean
      }
      claim_stripe_event: {
        Args: {
          _event_created: number
          _event_id: string
          _event_type: string
          _subscription_id: string
        }
        Returns: boolean
      }
      club_has_managers: {
        Args: { _club_profile_id: string }
        Returns: boolean
      }
      count_cycles_intakes: {
        Args: { _cycle_ids: string[] }
        Returns: {
          cycle_id: string
          n: number
        }[]
      }
      count_registrations_intakes: {
        Args: { _registration_ids: string[] }
        Returns: {
          n: number
          registration_id: string
        }[]
      }
      create_invoice_deduped: { Args: { _payload: Json }; Returns: Json }
      create_rebook_group_guest: {
        Args: {
          _email?: string
          _first_name: string
          _last_name?: string
          _phone?: string
          _token: string
        }
        Returns: string
      }
      create_registration: {
        Args: {
          p_currency: string
          p_description: string
          p_end_date: string
          p_enrollment_deadline: string
          p_format: string
          p_location_id: string
          p_name: string
          p_owner_id: string
          p_owner_type: string
          p_price_table: Json
          p_settings: Json
          p_start_date: string
          p_status: string
          p_terms: string
          p_total_price: number
        }
        Returns: {
          created_at: string
          currency: string
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          format: string
          id: string
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_table: Json | null
          settings: Json
          source_cycle_id: string | null
          start_date: string | null
          status: string
          terms: string | null
          total_price: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "registrations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_registration_with_cycle: {
        Args: {
          p_currency: string
          p_description: string
          p_end_date: string
          p_enrollment_deadline: string
          p_format: string
          p_is_always_open: boolean
          p_location_id: string
          p_name: string
          p_owner_id: string
          p_owner_type: string
          p_price_table: Json
          p_settings: Json
          p_start_date: string
          p_status: string
          p_terms: string
          p_total_price: number
        }
        Returns: {
          created_at: string
          currency: string
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          format: string
          id: string
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_table: Json | null
          settings: Json
          source_cycle_id: string | null
          start_date: string | null
          status: string
          terms: string | null
          total_price: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "registrations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      digits_only: { Args: { _value: string }; Returns: string }
      expire_lapsed_priority_claims: { Args: never; Returns: number }
      expired_holds_over_capacity: {
        Args: { _booking_ids: string[] }
        Returns: {
          booking_id: string
        }[]
      }
      filter_academy_priority_ids: {
        Args: {
          _academy_profile_id: string
          _guest_ids: string[]
          _profile_ids: string[]
        }
        Returns: {
          guest_player_id: string
          profile_id: string
        }[]
      }
      finalize_cycle_proposals: { Args: { p_cycle_id: string }; Returns: Json }
      find_guest_players_by_email_for_academy: {
        Args: {
          _academy_profile_id: string
          _email: string
          _trainer_ids: string[]
        }
        Returns: {
          full_name: string
          id: string
        }[]
      }
      fold_search_text: { Args: { _value: string }; Returns: string }
      gen_random_bytes: { Args: { len: number }; Returns: string }
      gen_short_code: { Args: { _len?: number }; Returns: string }
      generate_location_slug: {
        Args: { city: string; name: string }
        Returns: string
      }
      generate_trainer_slug: { Args: { full_name: string }; Returns: string }
      generate_unique_public_handle: {
        Args: { _name: string; _owner_id: string; _owner_type: string }
        Returns: string
      }
      generate_unique_trainer_slug: {
        Args: { _full_name: string; _trainer_id: string }
        Returns: string
      }
      get_academy_cyclus_groups: {
        Args: { p_academy_id: string }
        Returns: {
          category_color: string
          category_id: string
          category_name: string
          cycle_name: string
          cyclus_id: string
          cyclus_name_fallback: string
          first_slot_id: string
          group_suffix: string
          group_type: string
          has_cycle_row: boolean
          is_public: boolean
          is_registration: boolean
          kind: string
          location_name: string
          max_booked: number
          max_participants: number
          payment_status_summary: string
          period_end: string
          period_start: string
          player_count: number
          player_names: string[]
          price_per_session: number
          sessions: number
          status: string
          trainer_id: string
          trainer_name: string
        }[]
      }
      get_academy_cyclus_labels: {
        Args: { p_academy_profile_id: string }
        Returns: {
          cycle_id: string
          earliest_start: string
          first_names: string[]
          location_name: string
        }[]
      }
      get_academy_dashboard_analytics: {
        Args: { _academy_profile_id: string; _months?: number }
        Returns: Json
      }
      get_academy_invoice_cancelled_count: {
        Args: {
          p_academy_profile_id: string
          p_location_id?: string
          p_trainer_id?: string
        }
        Returns: number
      }
      get_academy_invoice_delivery_summary: {
        Args: {
          p_academy_profile_id: string
          p_location_id?: string
          p_tab?: string
          p_trainer_id?: string
        }
        Returns: {
          bounced: number
          delivered: number
          no_email: number
          pending: number
          total: number
        }[]
      }
      get_academy_invoice_summary: {
        Args: {
          p_academy_profile_id: string
          p_location_id?: string
          p_trainer_id?: string
        }
        Returns: {
          count_draft: number
          count_paid: number
          count_unpaid: number
          sum_unpaid: number
        }[]
      }
      get_academy_invoice_summary_filtered: {
        Args: {
          p_academy_profile_id: string
          p_delivery?: string
          p_location_id?: string
          p_no_email?: boolean
          p_search?: string
          p_status?: string
          p_trainer_id?: string
        }
        Returns: {
          count_draft: number
          count_paid: number
          count_unpaid: number
          sum_unpaid: number
        }[]
      }
      get_academy_invoices: {
        Args: {
          p_academy_profile_id: string
          p_delivery?: string
          p_limit?: number
          p_location_id?: string
          p_no_email?: boolean
          p_offset?: number
          p_search?: string
          p_sort?: string
          p_sort_dir?: string
          p_status?: string
          p_tab?: string
          p_trainer_id?: string
        }
        Returns: {
          academy_profile_id: string
          booking_ids: string[]
          computed_status: string
          created_at: string
          delivery_status: string
          due_date: string
          forwarded_at: string
          guest_player_id: string
          id: string
          invoice_date: string
          invoice_number: string
          line_items: Json
          linked_email: string
          location_id: string
          mollie_payment_id: string
          mollie_payment_url: string
          notes: string
          paid_at: string
          pdf_url: string
          player_address: string
          player_btw_number: string
          player_business_name: string
          player_id: string
          player_name: string
          prices_include_vat: boolean
          public_token: string
          public_token_revoked_at: string
          sent_at: string
          split_count: number
          status: string
          subtotal: number
          total: number
          total_count: number
          trainer_id: string
          updated_at: string
          vat_amount: number
          vat_breakdown: Json
          vat_rate: number
        }[]
      }
      get_academy_undeliverable_recipients: {
        Args: { p_academy_profile_id: string }
        Returns: {
          email: string
          full_name: string
          guest_player_id: string
          last_event_at: string
          player_key: string
          player_type: string
          profile_id: string
          state: string
        }[]
      }
      get_guest_booking_by_token: {
        Args: { _token: string }
        Returns: {
          academy_profile_id: string
          booking_id: string
          cyclus_name: string
          end_time: string
          hold_expires_at: string
          mollie_payment_id: string
          payment_amount: number
          payment_status: string
          session_count: number
          slot_id: string
          start_time: string
          status: string
          trainer_id: string
        }[]
      }
      get_invoice_delivery_status: {
        Args: { p_invoice_id: string }
        Returns: string
      }
      get_invoice_recipient_email: {
        Args: { _invoice_id: string }
        Returns: string
      }
      get_invoice_recipient_identity: {
        Args: {
          _academy_profile_id?: string
          _guest_player_id?: string
          _player_id?: string
        }
        Returns: {
          billing_address: string
          billing_btw_number: string
          billing_business_name: string
          email: string
          full_name: string
          phone: string
        }[]
      }
      get_invoice_status_history: {
        Args: { p_invoice_id: string }
        Returns: {
          changed_at: string
          changed_by: string
          changed_by_name: string
          new_status: string
          old_status: string
          reason: string
        }[]
      }
      get_invoices_delivery_status: {
        Args: { p_invoice_ids: string[] }
        Returns: {
          delivery_status: string
          invoice_id: string
          linked_email: string
        }[]
      }
      get_location_review_stats: {
        Args: { _location_id: string }
        Returns: Json
      }
      get_my_linked_guest_bookings: { Args: never; Returns: Json }
      get_my_paid_booking_ids: {
        Args: never
        Returns: {
          booking_id: string
        }[]
      }
      get_my_pending_priority_claims: {
        Args: never
        Returns: {
          claim_token: string
          cyclus_id: string
          cyclus_name: string
          end_time: string
          id: string
          price_per_session: number
          priority_window_ends_at: string
          rebook_group_id: string
          slot_id: string
          start_time: string
        }[]
      }
      get_or_create_short_link: {
        Args: {
          _permanent?: boolean
          _target_id?: string
          _target_params?: Json
          _target_path: string
          _target_type: string
        }
        Returns: string
      }
      get_player_email_edit_capability: {
        Args: { _academy_profile_id: string; _profile_id: string }
        Returns: string
      }
      get_player_journey: {
        Args: { p_limit?: number; p_offset?: number; p_profile_id: string }
        Returns: {
          academy_profile_id: string
          end_time: string
          group_summary: string
          location_name: string
          own_notes: Json
          player_confirmed: boolean
          rating_at_session: number
          rating_system: string
          session_happened: boolean
          shared_coaching_notes: Json
          slot_id: string
          start_time: string
          total_count: number
          trainer_confirmed: boolean
          trainer_id: string
          trainer_name: string
        }[]
      }
      get_player_locations: {
        Args: {
          p_academy_profile_id: string
          p_guest_player_id: string
          p_profile_id: string
        }
        Returns: {
          location_id: string
          location_name: string
        }[]
      }
      get_players_overview: {
        Args: {
          p_filters?: Json
          p_limit?: number
          p_offset?: number
          p_scope: string
          p_scope_id: string
          p_search?: string
          p_sort?: string
          p_sort_dir?: string
        }
        Returns: {
          academy_notes: string
          billing_address: string
          billing_btw_number: string
          billing_business_name: string
          birth_date: string
          created_at: string
          email: string
          email_undeliverable: boolean
          full_name: string
          guest_player_id: string
          has_active_cyclus: boolean
          has_overdue_payment: boolean
          has_trained: boolean
          location_ids: string[]
          location_names: string[]
          metadata_id: string
          notes: string
          owner_trainer_id: string
          phone: string
          player_key: string
          player_type: string
          profile_id: string
          rating_system: string
          skill_rating: number
          source: string
          tag_ids: string[]
          total_count: number
          trainer_ids: string[]
        }[]
      }
      get_priority_claim_by_token: { Args: { _token: string }; Returns: Json }
      get_profile_id_for_user: { Args: { _user_id: string }; Returns: string }
      get_public_slot_occupancy: {
        Args: { _slot_ids: string[] }
        Returns: {
          occupied: number
          slot_id: string
        }[]
      }
      get_public_slot_payment_ready: {
        Args: { _slot_ids: string[] }
        Returns: {
          payment_ready: boolean
          slot_id: string
        }[]
      }
      get_rebook_group_by_token: { Args: { _token: string }; Returns: Json }
      get_short_codes: {
        Args: { _target_ids: string[]; _target_type: string }
        Returns: {
          code: string
          target_id: string
        }[]
      }
      get_trainer_dashboard_analytics: {
        Args: { _months?: number }
        Returns: Json
      }
      get_trainer_earnings_summary: {
        Args: {
          p_last_month_end: string
          p_last_month_start: string
          p_this_month_end: string
          p_this_month_start: string
        }
        Returns: {
          completed_paid_count: number
          last_month: number
          pending_amount: number
          pending_count: number
          this_month: number
          total_earnings: number
        }[]
      }
      get_trainer_invoice_delivery_summary: {
        Args: { p_tab?: string; p_trainer_id: string }
        Returns: {
          bounced: number
          delivered: number
          no_email: number
          pending: number
          total: number
        }[]
      }
      get_trainer_invoice_summary: {
        Args: { p_trainer_id: string }
        Returns: {
          count_draft: number
          count_paid: number
          count_unpaid: number
          sum_unpaid: number
        }[]
      }
      get_trainer_invoices: {
        Args: {
          p_delivery?: string
          p_limit?: number
          p_offset?: number
          p_search?: string
          p_sort?: string
          p_sort_dir?: string
          p_status?: string
          p_tab?: string
          p_trainer_id: string
        }
        Returns: {
          academy_profile_id: string
          booking_ids: string[]
          computed_status: string
          created_at: string
          delivery_status: string
          due_date: string
          forwarded_at: string
          guest_player_id: string
          id: string
          invoice_date: string
          invoice_number: string
          line_items: Json
          linked_email: string
          mollie_payment_id: string
          mollie_payment_url: string
          notes: string
          paid_at: string
          pdf_url: string
          player_address: string
          player_btw_number: string
          player_business_name: string
          player_id: string
          player_name: string
          prices_include_vat: boolean
          public_token: string
          public_token_revoked_at: string
          sent_at: string
          split_count: number
          status: string
          subtotal: number
          total: number
          total_count: number
          trainer_id: string
          updated_at: string
          vat_amount: number
          vat_breakdown: Json
          vat_rate: number
        }[]
      }
      get_unpaid_rebook_invoice_by_claim_token: {
        Args: { _token: string }
        Returns: Json
      }
      get_unseen_shared_feedback_count: {
        Args: { p_profile_id: string }
        Returns: number
      }
      get_user_academy_ids: { Args: { _user_id: string }; Returns: string[] }
      get_user_club_ids: { Args: { _user_id: string }; Returns: string[] }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      guest_belongs_to_user_academy: {
        Args: { _guest_id: string; _user_id: string }
        Returns: boolean
      }
      guest_booked_with_trainer: {
        Args: { _guest_id: string; _user_id: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_user_booked_trainer: {
        Args: { _trainer_profile_id: string }
        Returns: boolean
      }
      invoice_booking_set_key: { Args: { _ids: string[] }; Returns: string }
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
      is_cycle_member: {
        Args: { _cycle_id: string; _user_id: string }
        Returns: boolean
      }
      is_email_suppressed: { Args: { p_email: string }; Returns: boolean }
      is_player: { Args: { _user_id: string }; Returns: boolean }
      is_player_of_academy: {
        Args: { p_academy_profile_id: string; p_player_id: string }
        Returns: boolean
      }
      is_player_of_trainer: { Args: { p_player_id: string }; Returns: boolean }
      is_reserved_handle: { Args: { _handle: string }; Returns: boolean }
      is_trainer: { Args: { _user_id: string }; Returns: boolean }
      link_guest_data_to_profile: {
        Args: { _profile_id: string }
        Returns: Json
      }
      merge_guest_players: {
        Args: {
          p_fields?: Json
          p_scope: string
          p_scope_id: string
          p_source_guest_id: string
          p_target_guest_id: string
        }
        Returns: Json
      }
      next_invoice_sequence: {
        Args: { p_min?: number; p_profile_id: string; p_profile_type: string }
        Returns: number
      }
      player_has_active_booking_on_slot: {
        Args: { _slot_id: string }
        Returns: boolean
      }
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
      rebook_claims_needing_auto_reminder: {
        Args: { _lead_hours?: number }
        Returns: {
          academy_name: string
          claim_token: string
          cycle_id: string
          cycle_name: string
          guest_player_id: string
          player_id: string
          recipient_email: string
          recipient_name: string
        }[]
      }
      rebook_cycles_needing_member_open_notice: {
        Args: never
        Returns: {
          cycle_id: string
        }[]
      }
      rebook_group_apply: {
        Args: { _keep_keys?: Json; _new_guest_ids?: string[]; _token: string }
        Returns: Json
      }
      rebook_group_manage: {
        Args: {
          _invoice_id?: string
          _keep_keys?: Json
          _new_guest_ids?: string[]
          _token: string
        }
        Returns: Json
      }
      recalc_cycle_split_count: {
        Args: { _cyclus_id: string }
        Returns: number
      }
      reconcile_payments: {
        Args: { _since?: string }
        Returns: {
          check_name: string
          detail: Json
          entity_id: string
          entity_kind: string
          severity: string
        }[]
      }
      record_email_event: {
        Args: {
          p_academy_profile_id?: string
          p_bounce_type?: string
          p_event_type: string
          p_invoice_id?: string
          p_occurred_at?: string
          p_reason?: string
          p_recipient_email: string
          p_resend_email_id?: string
          p_resend_event_id?: string
          p_trainer_id?: string
        }
        Returns: undefined
      }
      record_priority_claim_intent: {
        Args: { _intent: string; _token: string }
        Returns: undefined
      }
      reinstate_rebook_claims: {
        Args: { _claim_ids: string[] }
        Returns: {
          claim_id: string
          outcome: string
        }[]
      }
      release_expired_guest_slot_holds: { Args: never; Returns: number }
      release_expired_rebook_holds: { Args: never; Returns: number }
      release_rebook_hold: { Args: { _booking_id: string }; Returns: Json }
      resolve_public_handle: { Args: { _handle: string }; Returns: Json }
      resolve_short_link: {
        Args: { _code: string }
        Returns: {
          permanent: boolean
          target_path: string
        }[]
      }
      resolve_slot_booking_tier: { Args: { _slot_id: string }; Returns: string }
      respond_to_priority_claim: {
        Args: { _action: string; _reason?: string; _token: string }
        Returns: Json
      }
      schedule_enrichment_job: { Args: never; Returns: number }
      schedule_invoice_health_check_job: { Args: never; Returns: number }
      schedule_logo_fetch_job: { Args: never; Returns: number }
      schedule_release_rebook_holds_job: { Args: never; Returns: number }
      set_player_location: {
        Args: {
          p_academy_profile_id: string
          p_dismissed: boolean
          p_guest_player_id: string
          p_location_id: string
          p_profile_id: string
        }
        Returns: undefined
      }
      slot_held_by_paid_group: { Args: { _slot_id: string }; Returns: boolean }
      stripe_subscription_has_newer_activation: {
        Args: { _event_created: number; _subscription_id: string }
        Returns: boolean
      }
      swap_member_booking: {
        Args: { _new_slot_id: string; _old_booking_id: string }
        Returns: Json
      }
      swap_slots: {
        Args: {
          _slot_a_end: string
          _slot_a_id: string
          _slot_a_start: string
          _slot_a_trainer_id: string
          _slot_b_end: string
          _slot_b_id: string
          _slot_b_start: string
          _slot_b_trainer_id: string
        }
        Returns: undefined
      }
      try_lock_cron_job: { Args: { p_job_name: string }; Returns: boolean }
      unclaim_rebook_member_open_notice: {
        Args: { _cycle_id: string }
        Returns: undefined
      }
      unlock_cron_job: { Args: { p_job_name: string }; Returns: boolean }
      unschedule_all_background_pg_cron_jobs: {
        Args: never
        Returns: undefined
      }
      unschedule_enrichment_job: { Args: never; Returns: undefined }
      unschedule_invoice_health_check_job: { Args: never; Returns: undefined }
      unschedule_logo_fetch_job: { Args: never; Returns: undefined }
      unschedule_release_rebook_holds_job: { Args: never; Returns: undefined }
      update_cycle_pricing: {
        Args: {
          _cycle_id: string
          _extra_costs: Json
          _price_per_session: number
          _prices_include_vat: boolean
          _split_payment: boolean
        }
        Returns: undefined
      }
      update_registration: {
        Args: {
          p_currency: string
          p_description: string
          p_end_date: string
          p_enrollment_deadline: string
          p_format: string
          p_location_id: string
          p_name: string
          p_price_table: Json
          p_registration_id: string
          p_settings: Json
          p_start_date: string
          p_status: string
          p_terms: string
          p_total_price: number
        }
        Returns: {
          created_at: string
          currency: string
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          format: string
          id: string
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_table: Json | null
          settings: Json
          source_cycle_id: string | null
          start_date: string | null
          status: string
          terms: string | null
          total_price: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "registrations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_registration_with_cycle: {
        Args: {
          p_currency: string
          p_description: string
          p_end_date: string
          p_enrollment_deadline: string
          p_format: string
          p_is_always_open: boolean
          p_location_id: string
          p_name: string
          p_price_table: Json
          p_settings: Json
          p_source_cycle_id: string
          p_start_date: string
          p_status: string
          p_terms: string
          p_total_price: number
        }
        Returns: {
          created_at: string
          currency: string
          description: string | null
          end_date: string | null
          enrollment_deadline: string | null
          format: string
          id: string
          location_id: string | null
          name: string
          owner_id: string
          owner_type: string
          price_table: Json | null
          settings: Json
          source_cycle_id: string | null
          start_date: string | null
          status: string
          terms: string | null
          total_price: number | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "registrations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      user_owns_registration: {
        Args: { _registration_id: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role:
        | "player"
        | "trainer"
        | "admin"
        | "club_manager"
        | "club"
        | "academy"
      banner_budget_type: "unlimited" | "impression_cap" | "click_cap"
      banner_event_type: "impression" | "click"
      banner_format: "image" | "html"
      play_frequency: "first_time" | "few_times" | "regularly" | "home_club"
      player_level: "beginner" | "intermediate" | "advanced" | "pro"
      review_status: "pending" | "approved" | "rejected"
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
  graphql_public: {
    Enums: {},
  },
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
      banner_budget_type: ["unlimited", "impression_cap", "click_cap"],
      banner_event_type: ["impression", "click"],
      banner_format: ["image", "html"],
      play_frequency: ["first_time", "few_times", "regularly", "home_club"],
      player_level: ["beginner", "intermediate", "advanced", "pro"],
      review_status: ["pending", "approved", "rejected"],
    },
  },
} as const

