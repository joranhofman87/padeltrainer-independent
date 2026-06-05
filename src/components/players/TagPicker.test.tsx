import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TagPicker } from './TagPicker';
import type { PlayerTag } from './playerTagColors';

const assignMock = vi.fn();
const createMock = vi.fn();
const removeMock = vi.fn();

vi.mock('@/lib/playerTagService', () => ({
  assignExistingTagToPlayer: (...args: unknown[]) => assignMock(...args),
  createTagAndAssignToPlayer: (...args: unknown[]) => createMock(...args),
  removeTagFromPlayer: (...args: unknown[]) => removeMock(...args),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string, opts?: { name?: string }) => {
      if (key === 'players.tags.createOption' && opts?.name) {
        return `Create "${opts.name}"`;
      }
      return defaultValue ?? key;
    },
  }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const tags: PlayerTag[] = [
  { id: 'tag-1', name: 'VIP', color: 'blue', academy_profile_id: 'academy-1' },
];

const playerKey = { guest_player_id: 'guest-1', profile_id: null };

describe('TagPicker', () => {
  beforeEach(() => {
    assignMock.mockReset();
    createMock.mockReset();
    removeMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('assigns an existing tag immediately and updates UI', async () => {
    const onSelectedTagIdsChange = vi.fn();
    const onTagsChange = vi.fn();

    assignMock.mockResolvedValue({ tagIds: ['tag-1'], error: null });

    render(
      <TagPicker
        academyId="academy-1"
        playerKey={playerKey}
        tags={tags}
        selectedTagIds={[]}
        onTagsChange={onTagsChange}
        onSelectedTagIdsChange={onSelectedTagIdsChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    fireEvent.click(screen.getByText('VIP'));

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalled();
      expect(onSelectedTagIdsChange).toHaveBeenCalledWith(['tag-1']);
    });
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('shows create option and creates + assigns on click', async () => {
    const onSelectedTagIdsChange = vi.fn();
    const onTagsChange = vi.fn();

    createMock.mockResolvedValue({
      tag: { id: 'tag-new', name: 'Lead', color: 'slate', academy_profile_id: 'academy-1' },
      tagIds: ['tag-new'],
      catalogTags: [
        ...tags,
        { id: 'tag-new', name: 'Lead', color: 'slate', academy_profile_id: 'academy-1' },
      ],
      error: null,
      isDuplicate: false,
    });

    render(
      <TagPicker
        academyId="academy-1"
        playerKey={playerKey}
        tags={tags}
        selectedTagIds={[]}
        onTagsChange={onTagsChange}
        onSelectedTagIdsChange={onSelectedTagIdsChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    fireEvent.change(screen.getByPlaceholderText(/search or create tag/i), {
      target: { value: 'Lead' },
    });
    fireEvent.click(screen.getByText('Create "Lead"'));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalled();
      expect(onTagsChange).toHaveBeenCalled();
      expect(onSelectedTagIdsChange).toHaveBeenCalledWith(['tag-new']);
    });
  });

  it('table variant shows at most two tags and a +N overflow indicator', () => {
    const manyTags: PlayerTag[] = [
      { id: 'tag-1', name: 'VIP', color: 'blue', academy_profile_id: 'academy-1' },
      { id: 'tag-2', name: 'Lead', color: 'green', academy_profile_id: 'academy-1' },
      { id: 'tag-3', name: 'Trial', color: 'amber', academy_profile_id: 'academy-1' },
    ];

    render(
      <TagPicker
        academyId="academy-1"
        playerKey={playerKey}
        tags={manyTags}
        selectedTagIds={['tag-1', 'tag-2', 'tag-3']}
        onTagsChange={vi.fn()}
        onSelectedTagIdsChange={vi.fn()}
        variant="table"
      />,
    );

    expect(screen.getByTestId('tag-picker-table')).toHaveClass('flex-nowrap');
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('Lead')).toBeInTheDocument();
    expect(screen.queryByText('Trial')).not.toBeInTheDocument();
    expect(screen.getByTestId('tag-picker-overflow-count')).toHaveTextContent('+1');
    expect(screen.getByTestId('tag-picker-add-button')).toHaveClass('whitespace-nowrap');
  });

  it('does not show create option for duplicate tag names', () => {
    render(
      <TagPicker
        academyId="academy-1"
        playerKey={playerKey}
        tags={tags}
        selectedTagIds={[]}
        onTagsChange={vi.fn()}
        onSelectedTagIdsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /add tag/i }));
    fireEvent.change(screen.getByPlaceholderText(/search or create tag/i), {
      target: { value: 'vip' },
    });

    expect(screen.queryByText(/create "/i)).not.toBeInTheDocument();
  });
});
