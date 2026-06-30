import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RebookRulesField } from './RebookRulesField';
import { getAcademyRebookRulesDefault, saveAcademyRebookRulesDefault } from '@/lib/rebookRules';

vi.mock('@/lib/rebookRules', () => ({
  getAcademyRebookRulesDefault: vi.fn(),
  saveAcademyRebookRulesDefault: vi.fn(),
}));

// Avoid mounting the real Tiptap editor in jsdom; expose value/onChange via a plain textarea.
vi.mock('@/components/ui/rich-text-editor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (html: string) => void }) => (
    <textarea data-testid="rte" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const getDefault = vi.mocked(getAcademyRebookRulesDefault);
const saveDefault = vi.mocked(saveAcademyRebookRulesDefault);

describe('RebookRulesField', () => {
  beforeEach(() => {
    getDefault.mockReset();
    saveDefault.mockReset();
  });

  it('seeds an empty field from the academy default on mount', async () => {
    getDefault.mockResolvedValue('<p>Default rules</p>');
    const onChange = vi.fn();
    render(<RebookRulesField academyProfileId="ac1" value="" onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('<p>Default rules</p>'));
    expect(getDefault).toHaveBeenCalledWith('ac1');
  });

  it('does NOT clobber an already-filled field with the default', async () => {
    getDefault.mockResolvedValue('<p>Default rules</p>');
    const onChange = vi.fn();
    render(<RebookRulesField academyProfileId="ac1" value="<p>Round-specific</p>" onChange={onChange} />);
    await waitFor(() => expect(getDefault).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does nothing when the academy has no default', async () => {
    getDefault.mockResolvedValue(null);
    const onChange = vi.fn();
    render(<RebookRulesField academyProfileId="ac1" value="" onChange={onChange} />);
    await waitFor(() => expect(getDefault).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('"Save as default" persists the current value to the academy default', async () => {
    getDefault.mockResolvedValue(null);
    saveDefault.mockResolvedValue();
    render(<RebookRulesField academyProfileId="ac1" value="<p>My rules</p>" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save as default/ }));
    await waitFor(() => expect(saveDefault).toHaveBeenCalledWith('ac1', '<p>My rules</p>'));
  });
});
