import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const success = vi.fn();
const error = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
  },
}));

import { CopyLinkButton } from './CopyLinkButton';

describe('CopyLinkButton', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    success.mockReset();
    error.mockReset();
    Object.assign(navigator, { clipboard: { writeText } });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  });

  it('copies the url and toasts success', async () => {
    writeText.mockResolvedValue(undefined);
    render(<CopyLinkButton url="https://padeltrainer.ai/s/abc" label="Copy link" toastLabel="Copied!" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://padeltrainer.ai/s/abc'));
    expect(success).toHaveBeenCalledWith('Copied!');
    expect(error).not.toHaveBeenCalled();
  });

  it('toasts an error when both copy paths fail', async () => {
    writeText.mockRejectedValue(new Error('blocked'));
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) });
    render(<CopyLinkButton url="https://padeltrainer.ai/s/abc" label="Copy link" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
  });

  it('suppresses the toast when toastLabel is null', async () => {
    writeText.mockResolvedValue(undefined);
    render(<CopyLinkButton url="https://padeltrainer.ai/s/abc" label="Copy link" toastLabel={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
