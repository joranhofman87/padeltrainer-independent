/**
 * Sitemap Generator Script
 * 
 * Generates a sitemap index + sub-sitemaps from the Edge Function.
 * Run with: bun run scripts/generate-sitemap.ts
 */

const BASE_URL = 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/sitemap';
const OUTPUT_DIR = './public';
const SITEMAPS_DIR = './public/sitemaps';

async function fetchAndSave(url: string, path: string): Promise<number> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed: ${response.status} ${url}`);
  const xml = await response.text();
  const fs = await import('fs');
  fs.writeFileSync(path, xml);
  return (xml.match(/<url>/g) || []).length;
}

async function generateSitemap() {
  console.log('🗺️  Generating sitemaps...');
  const fs = await import('fs');
  if (!fs.existsSync(SITEMAPS_DIR)) fs.mkdirSync(SITEMAPS_DIR, { recursive: true });

  // Fetch index
  await fetchAndSave(`${BASE_URL}?type=index`, `${OUTPUT_DIR}/sitemap.xml`);
  console.log('✅ Index saved');

  // Static
  const staticCount = await fetchAndSave(`${BASE_URL}?type=static`, `${SITEMAPS_DIR}/sitemap-static.xml`);
  console.log(`   Static: ${staticCount} URLs`);

  // Locations (paginated)
  let total = staticCount;
  for (let page = 1; ; page++) {
    const count = await fetchAndSave(`${BASE_URL}?type=locations&page=${page}`, `${SITEMAPS_DIR}/sitemap-locations-${page}.xml`);
    if (count === 0) { fs.unlinkSync(`${SITEMAPS_DIR}/sitemap-locations-${page}.xml`); break; }
    console.log(`   Locations page ${page}: ${count} URLs`);
    total += count;
  }

  // Cities (paginated)
  for (let page = 1; ; page++) {
    const count = await fetchAndSave(`${BASE_URL}?type=cities&page=${page}`, `${SITEMAPS_DIR}/sitemap-cities-${page}.xml`);
    if (count === 0) { fs.unlinkSync(`${SITEMAPS_DIR}/sitemap-cities-${page}.xml`); break; }
    console.log(`   Cities page ${page}: ${count} URLs`);
    total += count;
  }

  // Provinces
  const provCount = await fetchAndSave(`${BASE_URL}?type=provinces`, `${SITEMAPS_DIR}/sitemap-provinces.xml`);
  console.log(`   Provinces: ${provCount} URLs`);
  total += provCount;

  console.log(`\n📊 Total URLs: ${total}`);
}

generateSitemap();
