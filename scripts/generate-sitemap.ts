/**
 * Sitemap Generator Script
 * 
 * Generates a sitemap index + sub-sitemaps from the Edge Function.
 * Run with: bun run scripts/generate-sitemap.ts
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://ficwbdrzefmblkbkomzw.supabase.co';
const BASE_URL = `${SUPABASE_URL}/functions/v1/sitemap`;
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

function countPagesFromIndex(indexXml: string, prefix: string): number {
  const regex = new RegExp(`${prefix}(\\d+)\\.xml`, 'g');
  let max = 0;
  let match;
  while ((match = regex.exec(indexXml)) !== null) {
    max = Math.max(max, parseInt(match[1], 10));
  }
  return max;
}

async function generateSitemap() {
  console.log('🗺️  Generating sitemaps...');
  const fs = await import('fs');
  if (!fs.existsSync(SITEMAPS_DIR)) fs.mkdirSync(SITEMAPS_DIR, { recursive: true });

  // Fetch index
  await fetchAndSave(`${BASE_URL}?type=index`, `${OUTPUT_DIR}/sitemap.xml`);
  console.log('✅ Index saved');

  const indexXml = fs.readFileSync(`${OUTPUT_DIR}/sitemap.xml`, 'utf-8');

  // Static
  const staticCount = await fetchAndSave(`${BASE_URL}?type=static`, `${SITEMAPS_DIR}/sitemap-static.xml`);
  console.log(`   Static: ${staticCount} URLs`);

  // Content (Sanity CMS)
  const contentCount = await fetchAndSave(`${BASE_URL}?type=content`, `${SITEMAPS_DIR}/sitemap-content.xml`);
  console.log(`   Content: ${contentCount} URLs`);

  // Locations (exact page count from index)
  let total = staticCount + contentCount;
  const locationPages = countPagesFromIndex(indexXml, 'sitemap-locations-');
  for (let page = 1; page <= locationPages; page++) {
    const count = await fetchAndSave(`${BASE_URL}?type=locations&page=${page}`, `${SITEMAPS_DIR}/sitemap-locations-${page}.xml`);
    console.log(`   Locations page ${page}: ${count} URLs`);
    total += count;
  }

  // Cities (exact page count from index)
  const cityPages = countPagesFromIndex(indexXml, 'sitemap-cities-');
  for (let page = 1; page <= cityPages; page++) {
    const count = await fetchAndSave(`${BASE_URL}?type=cities&page=${page}`, `${SITEMAPS_DIR}/sitemap-cities-${page}.xml`);
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
