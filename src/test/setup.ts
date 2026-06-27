import "@testing-library/jest-dom";

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
