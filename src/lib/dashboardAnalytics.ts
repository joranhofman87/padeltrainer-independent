// Dashboard analytics — thin client over the tenant-scoped RPCs (migration 20260719100000).
// Both roles return the same shape: a zero-filled monthly series + KPI values.
import { supabase } from '@/lib/supabaseClient';

export interface MonthlyPoint {
  ym: string; // 'YYYY-MM'
  revenue: number;
  expenses: number;
  profit: number;
  new_registered: number;
  new_guest: number;
}

export interface DashboardKpis {
  revenue_this_month: number;
  revenue_last_month: number;
  expenses_this_month: number;
  new_players_this_month: number;
  new_players_last_month: number;
  outstanding_invoices: number;
}

export interface DashboardAnalytics {
  monthly: MonthlyPoint[];
  kpis: DashboardKpis;
}

const EMPTY_KPIS: DashboardKpis = {
  revenue_this_month: 0, revenue_last_month: 0, expenses_this_month: 0,
  new_players_this_month: 0, new_players_last_month: 0, outstanding_invoices: 0,
};

// jsonb numerics can arrive as strings — coerce everything to Number.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerce(raw: any): DashboardAnalytics {
  if (!raw) return { monthly: [], kpis: { ...EMPTY_KPIS } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monthly: MonthlyPoint[] = (raw.monthly ?? []).map((m: any) => ({
    ym: String(m.ym),
    revenue: Number(m.revenue) || 0,
    expenses: Number(m.expenses) || 0,
    profit: Number(m.profit) || 0,
    new_registered: Number(m.new_registered) || 0,
    new_guest: Number(m.new_guest) || 0,
  }));
  const k = raw.kpis ?? {};
  const kpis: DashboardKpis = {
    revenue_this_month: Number(k.revenue_this_month) || 0,
    revenue_last_month: Number(k.revenue_last_month) || 0,
    expenses_this_month: Number(k.expenses_this_month) || 0,
    new_players_this_month: Number(k.new_players_this_month) || 0,
    new_players_last_month: Number(k.new_players_last_month) || 0,
    outstanding_invoices: Number(k.outstanding_invoices) || 0,
  };
  return { monthly, kpis };
}

export async function fetchAcademyAnalytics(academyProfileId: string, months = 12): Promise<DashboardAnalytics> {
  const { data, error } = await supabase.rpc('get_academy_dashboard_analytics' as never, {
    _academy_profile_id: academyProfileId, _months: months,
  } as never);
  if (error) throw error;
  return coerce(data);
}

export async function fetchTrainerAnalytics(months = 12): Promise<DashboardAnalytics> {
  const { data, error } = await supabase.rpc('get_trainer_dashboard_analytics' as never, { _months: months } as never);
  if (error) throw error;
  return coerce(data);
}

/** % change vs the prior period. null when there's no prior baseline (avoid ÷0 / ∞%). */
export function pctDelta(current: number, previous: number): number | null {
  if (!previous) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}
