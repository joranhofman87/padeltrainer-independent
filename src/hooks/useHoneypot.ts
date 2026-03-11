import { useRef, useCallback } from 'react';
import { logger } from '@/lib/logger';

const MIN_SUBMIT_TIME_MS = 2000;

export function useHoneypot() {
  const honeypotRef = useRef<HTMLInputElement>(null);
  const mountedAt = useRef(Date.now());

  const isSuspicious = useCallback(() => {
    // Check honeypot field
    if (honeypotRef.current && honeypotRef.current.value) {
      logger.warn('Bot detected: honeypot filled', { component: 'useHoneypot' });
      return true;
    }
    // Check timing
    if (Date.now() - mountedAt.current < MIN_SUBMIT_TIME_MS) {
      logger.warn('Bot detected: form submitted too fast', { component: 'useHoneypot' });
      return true;
    }
    return false;
  }, []);

  return { honeypotRef, isSuspicious };
}
