import { describe, it, expect } from 'vitest';
import {
  addTagIdToSelection,
  appendTagToCatalog,
  canOfferCreateTag,
  filterTagsByQuery,
  findTagByName,
  isDuplicateTagName,
  normalizeTagName,
  upsertMetadataTagIds,
  type PlayerTagRow,
} from './playerTags';

const catalog: PlayerTagRow[] = [
  { id: '1', name: 'VIP', color: 'blue' },
  { id: '2', name: 'Beginner', color: 'green' },
];

describe('normalizeTagName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeTagName('  Jan   Club  ')).toBe('Jan Club');
  });
});

describe('isDuplicateTagName', () => {
  it('detects duplicates case-insensitively', () => {
    expect(isDuplicateTagName(catalog, 'vip')).toBe(true);
    expect(isDuplicateTagName(catalog, 'New Tag')).toBe(false);
  });
});

describe('canOfferCreateTag', () => {
  it('offers create when name is new', () => {
    expect(canOfferCreateTag(catalog, 'Lead')).toBe(true);
  });

  it('blocks create for duplicate names', () => {
    expect(canOfferCreateTag(catalog, 'vip')).toBe(false);
    expect(canOfferCreateTag(catalog, 'BEGINNER')).toBe(false);
  });
});

describe('findTagByName', () => {
  it('finds existing tag ignoring case', () => {
    expect(findTagByName(catalog, 'beginner')?.id).toBe('2');
  });
});

describe('filterTagsByQuery', () => {
  it('filters by substring', () => {
    expect(filterTagsByQuery(catalog, 'beg').map((t) => t.name)).toEqual(['Beginner']);
  });
});

describe('addTagIdToSelection', () => {
  it('adds without duplicates', () => {
    expect(addTagIdToSelection(['1'], '2')).toEqual(['1', '2']);
    expect(addTagIdToSelection(['1'], '1')).toEqual(['1']);
  });
});

describe('appendTagToCatalog', () => {
  it('appends and sorts', () => {
    const next = appendTagToCatalog(catalog, { id: '3', name: 'Alpha', color: 'slate' });
    expect(next.map((t) => t.name)).toEqual(['Alpha', 'Beginner', 'VIP']);
  });
});

describe('upsertMetadataTagIds', () => {
  it('updates existing metadata row', () => {
    const meta = [
      {
        id: 'm1',
        guest_player_id: 'g1',
        profile_id: null,
        notes: null,
        tag_ids: ['1'],
      },
    ];
    const next = upsertMetadataTagIds(meta, { guest_player_id: 'g1', profile_id: null }, ['1', '2']);
    expect(next[0].tag_ids).toEqual(['1', '2']);
  });

  it('inserts metadata row when missing', () => {
    const next = upsertMetadataTagIds([], { guest_player_id: 'g2', profile_id: null }, ['2']);
    expect(next).toHaveLength(1);
    expect(next[0].tag_ids).toEqual(['2']);
  });
});
