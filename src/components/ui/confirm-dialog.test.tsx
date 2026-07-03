import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';

function setup(overrides: Partial<ConfirmDialogProps> = {}) {
  const props: ConfirmDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Delete item?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<ConfirmDialog {...props} />);
  return props;
}

describe('ConfirmDialog', () => {
  it('renders title + description + confirm/cancel', () => {
    setup();
    expect(screen.getByText('Delete item?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('confirm calls onConfirm and does NOT auto-close (caller owns close)', () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('cancel calls onOpenChange(false)', () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('loading disables both buttons (and blocks the controlled close)', () => {
    const { onConfirm } = setup({ loading: true });
    const confirm = screen.getByRole('button', { name: /Delete/ });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('destructive variant (default) styles the confirm button red', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-destructive');
  });

  it('default variant does NOT use the destructive style', () => {
    setup({ variant: 'default', confirmLabel: 'Confirm' });
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toHaveClass('bg-destructive');
  });

  it('renders children (extra body) between description and footer', () => {
    setup({ children: <div data-testid="extra">extra body</div> });
    expect(screen.getByTestId('extra')).toBeInTheDocument();
  });

  it('applies confirmTestId to the confirm button', () => {
    setup({ confirmTestId: 'remove-confirm' });
    expect(screen.getByTestId('remove-confirm')).toBeInTheDocument();
  });

  it('confirmDisabled disables the confirm button and blocks onConfirm', () => {
    const { onConfirm } = setup({ confirmDisabled: true });
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('onCancel fires on the Cancel button click (which still closes)', () => {
    const onCancel = vi.fn();
    const { onOpenChange } = setup({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('onCancel does NOT fire on Escape dismissal (only the explicit button)', () => {
    const onCancel = vi.fn();
    const { onOpenChange } = setup({ onCancel });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
