// Per-academy cycle categories: a managed, colored list the academy assigns (one per cycle) to
// tell their kinds apart in the overview (Kids / Summer / Competition …). Mirrors the player-tag
// catalog, single-value. The assignment lives on cycles.category_id (a plain column — no
// settings-merge gotcha). Manager-gated by RLS on academy_cycle_categories + cycles.
import { supabase } from '@/lib/supabaseClient';

export interface CycleCategory {
  id: string;
  academy_profile_id: string;
  name: string;
  color: string;
}

/** List an academy's categories, alphabetical. */
export async function listCycleCategories(academyProfileId: string): Promise<CycleCategory[]> {
  const { data, error } = await supabase
    .from('academy_cycle_categories')
    .select('id, academy_profile_id, name, color')
    .eq('academy_profile_id', academyProfileId)
    .order('name');
  if (error) throw error;
  return (data ?? []) as CycleCategory[];
}

/** Create a category. Throws a typed 'duplicate' Error on the unique(academy,name) violation. */
export async function createCycleCategory(academyProfileId: string, name: string, color: string): Promise<CycleCategory> {
  const trimmed = name.trim();
  const { data, error } = await supabase
    .from('academy_cycle_categories')
    .insert({ academy_profile_id: academyProfileId, name: trimmed, color })
    .select('id, academy_profile_id, name, color')
    .single();
  if (error) {
    if (error.code === '23505') throw new Error('duplicate');
    throw error;
  }
  return data as CycleCategory;
}

export async function updateCycleCategory(id: string, patch: { name?: string; color?: string }): Promise<void> {
  const clean: { name?: string; color?: string } = {};
  if (patch.name !== undefined) clean.name = patch.name.trim();
  if (patch.color !== undefined) clean.color = patch.color;
  const { error } = await supabase.from('academy_cycle_categories').update(clean).eq('id', id);
  if (error) {
    if (error.code === '23505') throw new Error('duplicate');
    throw error;
  }
}

/** Delete a category. Cycles referencing it are un-categorized (FK ON DELETE SET NULL). */
export async function deleteCycleCategory(id: string): Promise<void> {
  const { error } = await supabase.from('academy_cycle_categories').delete().eq('id', id);
  if (error) throw error;
}

/** Assign (or clear, with null) a cycle's category — a plain column write, no settings merge. */
export async function setCycleCategory(cycleId: string, categoryId: string | null): Promise<void> {
  const { error } = await supabase.from('cycles').update({ category_id: categoryId }).eq('id', cycleId);
  if (error) throw error;
}
