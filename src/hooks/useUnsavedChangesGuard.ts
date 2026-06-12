import { useEffect } from 'react';

/**
 * Shows the browser's native "leave site?" prompt on tab close, refresh, or
 * external navigation while `isDirty` is true.
 *
 * In-app route changes are NOT blocked: App.tsx mounts `<BrowserRouter>` (a
 * component router) and react-router's `useBlocker` API only works on data
 * routers (`createBrowserRouter`). Forms that must survive an in-app unmount
 * (e.g. the session-expiry redirect to login) should pair this guard with
 * draft persistence, as CycleForm does.
 */
export function useUnsavedChangesGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome still requires returnValue to be set for the prompt to appear.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);
}
