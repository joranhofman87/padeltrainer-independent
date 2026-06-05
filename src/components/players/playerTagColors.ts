// Predefined tag color palette using HSL semantic tokens that work in light + dark mode.
// Keep as a fixed list so badges render consistently.
export const TAG_COLORS = [
  { key: 'slate',  className: 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-700' },
  { key: 'blue',   className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200 border-blue-300 dark:border-blue-800' },
  { key: 'green',  className: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200 border-green-300 dark:border-green-800' },
  { key: 'amber',  className: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200 border-amber-300 dark:border-amber-800' },
  { key: 'red',    className: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200 border-red-300 dark:border-red-800' },
  { key: 'purple', className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200 border-purple-300 dark:border-purple-800' },
  { key: 'pink',   className: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200 border-pink-300 dark:border-pink-800' },
  { key: 'cyan',   className: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200 border-cyan-300 dark:border-cyan-800' },
] as const;

export function getTagColorClass(color: string | null | undefined): string {
  return TAG_COLORS.find(c => c.key === color)?.className || TAG_COLORS[0].className;
}

export type PlayerTag = {
  id: string;
  academy_profile_id: string;
  name: string;
  color: string;
};

export type PlayerMetadata = {
  id: string;
  guest_player_id: string | null;
  profile_id: string | null;
  notes: string | null;
  tag_ids: string[];
  removed_at?: string | null;
  removed_by?: string | null;
  remove_reason?: string | null;
};
