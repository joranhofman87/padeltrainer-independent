import { supabase } from '@/lib/supabaseClient';
import type { Database } from '@/integrations/supabase/types';
import { logger } from '@/lib/logger';

export type TrainerType = 'independent' | 'club_trainer' | 'academy_owner';

export type LessonsPerWeekRange = 'none' | '1-5' | '6-15' | '16-30' | '30+';

export type PlayerCountRange = '0' | '1-10' | '11-30' | '30+';

export type PainTag =
  | 'chasing_payments'
  | 'scheduling_chaos'
  | 'no_shows'
  | 'empty_slots'
  | 'grow_player_base'
  | 'cycle_admin'
  | 'look_professional';

export type AdminHoursRange = '<1' | '1-3' | '3-6' | '6+';

export type LiveWindow = 'this_week' | 'two_weeks' | 'one_month' | 'exploring';

export type OnboardingResponsesRow =
  Database['public']['Tables']['trainer_onboarding_responses']['Row'];

export type OnboardingResponsesInsert =
  Database['public']['Tables']['trainer_onboarding_responses']['Insert'];

/** Fields that may be upserted; trainer_profile_id is set only via the function argument. */
export type OnboardingResponsesPartial = Partial<{
  trainer_type: TrainerType | null;
  lessons_per_week_range: LessonsPerWeekRange | null;
  player_count_range: PlayerCountRange | null;
  primary_city: string | null;
  primary_pains: PainTag[] | null;
  admin_hours_per_week: AdminHoursRange | null;
  target_live_window: LiveWindow | null;
  target_live_date: string | null;
  critical_event_note: string | null;
  decision_makers: string[] | null;
  previous_tools: string[] | null;
  decision_criteria: string[] | null;
  completed_at: string | null;
}>;

export interface PainOption {
  id: PainTag;
  labelKey: string;
  descriptionKey?: string;
  iconName?: string;
}

export const PAIN_OPTIONS: PainOption[] = [
  {
    id: 'chasing_payments',
    labelKey: 'onboarding.spiced.painImpact.pains.chasing_payments.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.chasing_payments.description',
    iconName: 'CreditCard',
  },
  {
    id: 'scheduling_chaos',
    labelKey: 'onboarding.spiced.painImpact.pains.scheduling_chaos.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.scheduling_chaos.description',
    iconName: 'Calendar',
  },
  {
    id: 'no_shows',
    labelKey: 'onboarding.spiced.painImpact.pains.no_shows.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.no_shows.description',
    iconName: 'UserX',
  },
  {
    id: 'empty_slots',
    labelKey: 'onboarding.spiced.painImpact.pains.empty_slots.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.empty_slots.description',
    iconName: 'CalendarX',
  },
  {
    id: 'grow_player_base',
    labelKey: 'onboarding.spiced.painImpact.pains.grow_player_base.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.grow_player_base.description',
    iconName: 'Users',
  },
  {
    id: 'cycle_admin',
    labelKey: 'onboarding.spiced.painImpact.pains.cycle_admin.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.cycle_admin.description',
    iconName: 'ClipboardList',
  },
  {
    id: 'look_professional',
    labelKey: 'onboarding.spiced.painImpact.pains.look_professional.label',
    descriptionKey: 'onboarding.spiced.painImpact.pains.look_professional.description',
    iconName: 'Sparkles',
  },
];

const LIVE_WINDOW_DAY_OFFSETS: Record<Exclude<LiveWindow, 'exploring'>, number> = {
  this_week: 7,
  two_weeks: 14,
  one_month: 30,
};

const ADMIN_HOURS_ANNUAL_ESTIMATE: Record<AdminHoursRange, number> = {
  '<1': 26,
  '1-3': 104,
  '3-6': 234,
  '6+': 312,
};

function toIsoDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Maps a live-window choice to a target date (local calendar), or null when exploring. */
export function computeTargetLiveDate(window: LiveWindow): string | null {
  if (window === 'exploring') {
    return null;
  }

  const offsetDays = LIVE_WINDOW_DAY_OFFSETS[window];
  const target = new Date();
  target.setDate(target.getDate() + offsetDays);
  return toIsoDateString(target);
}

/** Rough annual admin hours from weekly range (for impact copy / analytics). */
export function getEstimatedAnnualHours(
  adminRange: AdminHoursRange | null | undefined,
): number | null {
  if (adminRange == null) {
    return null;
  }
  return ADMIN_HOURS_ANNUAL_ESTIMATE[adminRange];
}

function toUpsertPayload(partial: OnboardingResponsesPartial): Omit<
  OnboardingResponsesInsert,
  'trainer_profile_id'
> {
  const payload = { ...partial } as Record<string, unknown>;
  delete payload.trainer_profile_id;
  delete payload.created_at;
  delete payload.updated_at;
  return payload as Omit<OnboardingResponsesInsert, 'trainer_profile_id'>;
}

function wrapDbError(message: string, error: unknown, context: Record<string, unknown>): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(message, err, { component: 'onboardingResponses', ...context });
  return new Error(`${message}: ${err.message}`);
}

export async function getOnboardingResponses(
  trainerProfileId: string,
): Promise<OnboardingResponsesRow | null> {
  const { data, error } = await supabase
    .from('trainer_onboarding_responses')
    .select('*')
    .eq('trainer_profile_id', trainerProfileId)
    .maybeSingle();

  if (error) {
    throw wrapDbError('Failed to load onboarding responses', error, { trainerProfileId });
  }

  return data;
}

export async function upsertOnboardingResponses(
  trainerProfileId: string,
  partial: OnboardingResponsesPartial,
): Promise<OnboardingResponsesRow> {
  const payload = toUpsertPayload(partial);

  const { data, error } = await supabase
    .from('trainer_onboarding_responses')
    .upsert(
      {
        trainer_profile_id: trainerProfileId,
        ...payload,
      },
      { onConflict: 'trainer_profile_id' },
    )
    .select()
    .single();

  if (error) {
    throw wrapDbError('Failed to save onboarding responses', error, { trainerProfileId });
  }

  if (!data) {
    throw new Error('Failed to save onboarding responses: no row returned');
  }

  return data;
}
