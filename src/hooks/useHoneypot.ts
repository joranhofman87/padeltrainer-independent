import { useRef, useCallback } from 'react';

const MIN_SUBMIT_TIME_MS = 2000;

export function useHoneypot() {
  const honeypotRef = useRef<HTMLInputElement>(null);
  const mountedAt = useRef(Date.now());

  const isSuspicious = useCallback(() => {
    // Check honeypot field
    if (honeypotRef.current && honeypotRef.current.value) {
      console.warn('Bot detected: honeypot filled');
      return true;
    }
    // Check timing
    if (Date.now() - mountedAt.current < MIN_SUBMIT_TIME_MS) {
      console.warn('Bot detected: form submitted too fast');
      return true;
    }
    return false;
  }, []);

  return { honeypotRef, isSuspicious };
}
