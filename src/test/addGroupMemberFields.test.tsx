import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';
import { AddGroupMemberFields } from '@/components/cycles/AddGroupMemberFields';

// Slice C / owner decision #4: a NEW group member must be fully reachable — first name, last name,
// email, phone are ALL required. onAdd must not fire until every field is present + the email is valid.
function fill(container: HTMLElement, id: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(`#${id}`)!;
  fireEvent.change(el, { target: { value } });
}

describe('AddGroupMemberFields — all four contact fields required (Slice C)', () => {
  it('does NOT emit until first+last+email+phone are all provided and the email is valid', () => {
    const onAdd = vi.fn();
    const { container, getByRole } = renderWithCycles(<AddGroupMemberFields onAdd={onAdd} />);
    const add = () => fireEvent.click(getByRole('button'));

    // Only first name → blocked
    fill(container, 'ngm-first', 'Sam');
    add();
    expect(onAdd).not.toHaveBeenCalled();

    // + last name, still no email/phone → blocked
    fill(container, 'ngm-last', 'De Vries');
    add();
    expect(onAdd).not.toHaveBeenCalled();

    // + invalid email → blocked
    fill(container, 'ngm-email', 'not-an-email');
    add();
    expect(onAdd).not.toHaveBeenCalled();

    // + valid email but no phone → still blocked
    fill(container, 'ngm-email', 'sam@example.com');
    add();
    expect(onAdd).not.toHaveBeenCalled();

    // + phone → now it emits, with every field trimmed + present
    fill(container, 'ngm-phone', '+31612345678');
    add();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      firstName: 'Sam',
      lastName: 'De Vries',
      email: 'sam@example.com',
      phone: '+31612345678',
    });
  });

  it('resets the fields after a successful add', () => {
    const onAdd = vi.fn();
    const { container, getByRole } = renderWithCycles(<AddGroupMemberFields onAdd={onAdd} />);
    fill(container, 'ngm-first', 'Ana');
    fill(container, 'ngm-last', 'Kern');
    fill(container, 'ngm-email', 'ana@example.com');
    fill(container, 'ngm-phone', '0612345678');
    fireEvent.click(getByRole('button'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLInputElement>('#ngm-first')!.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('#ngm-phone')!.value).toBe('');
  });
});
