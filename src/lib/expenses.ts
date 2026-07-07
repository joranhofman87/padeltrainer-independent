// Expenses — money-OUT entries owned by exactly one of an academy or an independent
// trainer. RLS (migration 20260718100000) is the security boundary; the owner filter
// here is for query scoping. Powers the dashboard money chart (revenue vs expenses).
import { supabase } from '@/lib/supabaseClient';

/** Fixed category set — validated client-side + labelled via i18n (expenses.category.*). */
export const EXPENSE_CATEGORIES = [
  'court_rental',
  'trainer_payout',
  'salaries',
  'marketing',
  'equipment',
  'software',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface Expense {
  id: string;
  academy_profile_id: string | null;
  trainer_id: string | null;
  expense_date: string; // YYYY-MM-DD
  amount: number;
  category: string;
  description: string | null;
  created_at: string;
}

/** Exactly one owner — academy XOR trainer (mirrors the DB CHECK). */
export type ExpenseOwner = { academyProfileId: string } | { trainerId: string };

export interface ExpenseInput {
  expense_date: string;
  amount: number;
  category: ExpenseCategory | string;
  description?: string | null;
}

const isAcademy = (o: ExpenseOwner): o is { academyProfileId: string } => 'academyProfileId' in o;
const ownerCols = (o: ExpenseOwner) =>
  isAcademy(o)
    ? { academy_profile_id: o.academyProfileId, trainer_id: null }
    : { academy_profile_id: null, trainer_id: o.trainerId };

const SELECT_COLS = 'id, academy_profile_id, trainer_id, expense_date, amount, category, description, created_at';

// `expenses` is not in the generated Supabase types yet (types.ts drift), so the fully-typed
// builder recurses infinitely — use a loosely-typed handle, mirroring the admin content tables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const expensesTable = () => (supabase as any).from('expenses');

export async function listExpenses(owner: ExpenseOwner): Promise<Expense[]> {
  let q = expensesTable().select(SELECT_COLS).order('expense_date', { ascending: false });
  q = isAcademy(owner) ? q.eq('academy_profile_id', owner.academyProfileId) : q.eq('trainer_id', owner.trainerId);
  const { data, error } = await q;
  if (error) throw error;
  // `expenses` is not in the generated Supabase types yet (types.ts drift), so the client
  // infers an error result type — cast through unknown, as the rest of the codebase does.
  return (data ?? []) as unknown as Expense[];
}

export async function createExpense(owner: ExpenseOwner, input: ExpenseInput): Promise<Expense> {
  const { data, error } = await expensesTable()
    .insert({
      ...ownerCols(owner),
      expense_date: input.expense_date,
      amount: input.amount,
      category: input.category,
      description: input.description?.trim() || null,
    })
    .select(SELECT_COLS)
    .single();
  if (error) throw error;
  return data as unknown as Expense;
}

export async function updateExpense(id: string, input: ExpenseInput): Promise<void> {
  const { error } = await expensesTable()
    .update({
      expense_date: input.expense_date,
      amount: input.amount,
      category: input.category,
      description: input.description?.trim() || null,
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await expensesTable().delete().eq('id', id);
  if (error) throw error;
}
