import "@testing-library/jest-dom";

// Web Storage shim for the `node` environment. Node 24 (CI) has no global
// `localStorage`, so any `node`-env test that transitively imports the browser
// Supabase client crashes at module-load — `src/integrations/supabase/client.ts`
// passes `storage: localStorage` to createClient (that file is auto-generated,
// so the fix belongs here). jsdom already provides Storage, hence the guard.
if (typeof globalThis.localStorage === "undefined") {
  class MemoryStorage {
    private store = new Map<string, string>();
    get length() { return this.store.size; }
    clear() { this.store.clear(); }
    getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
    key(i: number) { return Array.from(this.store.keys())[i] ?? null; }
    removeItem(key: string) { this.store.delete(key); }
    setItem(key: string, value: string) { this.store.set(key, String(value)); }
  }
  globalThis.localStorage = new MemoryStorage() as unknown as Storage;
  globalThis.sessionStorage = new MemoryStorage() as unknown as Storage;
}

// jsdom-only DOM shims. Test files pinned to the `node` environment (e.g. PGlite-backed DB tests)
// have no `window`, so guard rather than crash this shared setup for them.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });

  // Polyfill ResizeObserver for radix-ui components
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
}
