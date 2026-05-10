/**
 * SEO regression test — guards core technical SEO output.
 *
 * Asserts that <SEO /> emits:
 *   - canonical URL with stripped trailing slash
 *   - one hreflang alternate per supported locale
 *   - x-default pointing at the English locale
 *   - basic Open Graph + Twitter tags
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { SEO } from './SEO';

function render(url: string, currentRoutePath = '/en/trainer/jane-doe') {
  const helmetContext: { helmet?: any } = {};
  renderToStaticMarkup(
    <HelmetProvider context={helmetContext}>
      <MemoryRouter initialEntries={[currentRoutePath]}>
        <Routes>
          <Route
            path="/:lang/*"
            element={
              <SEO
                title="Jane Doe"
                description="Book Jane Doe for padel coaching."
                url={url}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
  const helmet = helmetContext.helmet!;
  return {
    title: helmet.title.toString(),
    meta: helmet.meta.toString(),
    link: helmet.link.toString(),
  };
}

describe('SEO component', () => {
  beforeEach(() => {
    // Helmet caches per-render in static mode; nothing to reset.
  });

  it('emits canonical without trailing slash', () => {
    const { link } = render('/en/trainer/jane-doe/');
    expect(link).toContain('rel="canonical"');
    expect(link).toContain('href="https://padeltrainer.ai/en/trainer/jane-doe"');
    expect(link).not.toContain('jane-doe/"');
  });

  it('emits one hreflang per supported locale + x-default to /en', () => {
    const { link } = render('/en/trainer/jane-doe');
    for (const l of ['en', 'nl', 'es', 'de', 'fr', 'it']) {
      expect(link).toContain(`hreflang="${l}"`);
      expect(link).toContain(`https://padeltrainer.ai/${l}/trainer/jane-doe`);
    }
    expect(link).toContain('hreflang="x-default"');
    // x-default must point at /en, not the unprefixed root (which 301s to NL).
    const xDefault = /hreflang="x-default"\s+href="([^"]+)"/.exec(link)?.[1];
    expect(xDefault).toBe('https://padeltrainer.ai/en/trainer/jane-doe');
  });

  it('emits Open Graph + Twitter card tags', () => {
    const { meta, title } = render('/en/trainer/jane-doe');
    expect(title).toContain('Jane Doe');
    expect(meta).toContain('property="og:title"');
    expect(meta).toContain('property="og:url"');
    expect(meta).toContain('property="og:image"');
    expect(meta).toContain('property="og:locale"');
    expect(meta).toContain('content="en_US"');
    expect(meta).toContain('name="twitter:card"');
    expect(meta).toContain('content="summary_large_image"');
  });
});
