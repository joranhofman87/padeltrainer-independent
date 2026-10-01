import { useTranslation } from 'react-i18next';
import { StickyNote } from 'lucide-react';

interface PlayerNotesCellProps {
  /** Owner: pass either academyId OR trainerId (one required). */
  academyId?: string;
  trainerId?: string;
  playerKey: { guest_player_id: string | null; profile_id: string | null };
  notes: string;
  onChanged: () => void;
  /** View-only: render the note text without the edit popover. */
  readOnly?: boolean;
}

/**
 * ABC-16 H0 — internal notes are shown, not edited.
 *
 * The editor wrote `academy_player_metadata` directly, creating the row when none existed.
 * That row was accepted by three authorization predicates as proof of the academy↔player
 * relationship for a caller-chosen subject, so the write is contained until an H1 command
 * derives the subject from canonical membership server-side.
 *
 * The note itself is NOT hidden: every note that existed before still renders exactly as it
 * did in the previous read-only mode. Only the popover editor is gone, so there is no
 * control that can appear to save and then be refused by the database.
 */
export function PlayerNotesCell({ notes }: PlayerNotesCellProps) {
  const { t } = useTranslation('trainer');
  const preview = (notes || '').trim();

  // The title carries the explanation: a cell in a dense table has no room for a banner, and
  // an unexplained control that simply stopped being clickable reads as a bug.
  const title = preview
    ? `${preview}\n\n${t('players.notesReadOnly', 'Notes are temporarily view-only while we improve how players are linked to your academy.')}`
    : t('players.notesReadOnly', 'Notes are temporarily view-only while we improve how players are linked to your academy.');

  return (
    <span
      className="flex h-8 min-w-0 items-center gap-1 overflow-hidden text-xs text-muted-foreground"
      title={title}
      data-testid="player-notes-cell-readonly"
    >
      <StickyNote className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">{preview || '—'}</span>
    </span>
  );
}
