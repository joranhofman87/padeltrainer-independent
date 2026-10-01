import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The lifecycle of a page export: at most one runs at a time, Cancel aborts it, and a change of
 * `scopeKey` (another academy, say) or unmounting aborts it too — so a file never mixes scopes. The task
 * receives the AbortSignal and owns everything else (fetch, file, messages).
 */
export function useCancellableExport(scopeKey: string | undefined) {
  const controllerRef = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => () => controllerRef.current?.abort(), [scopeKey]);

  const run = useCallback(async (task: (signal: AbortSignal) => Promise<void>) => {
    if (controllerRef.current) return; // single-flight
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    try {
      await task(controller.signal);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  return { running, run, cancel };
}
