/**
 * Sitemap Generator Script
 * 
 * This script generates a complete sitemap.xml with all:
 * - Static marketing pages (9 pages × 2 languages = 18 URLs)
 * - Trainer profile pages (dynamic)
 * - Location pages (574+ locations × 2 languages)
 * - City landing pages (280+ cities × 2 languages)
 * 
 * Run with: bun run scripts/generate-sitemap.ts
 * Or: npx tsx scripts/generate-sitemap.ts
 * 
 * The script fetches data from the Supabase Edge Function and saves
 * the result to public/sitemap.xml
 */

const SITEMAP_EDGE_FUNCTION_URL = 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/sitemap';
const OUTPUT_PATH = './public/sitemap.xml';

async function generateSitemap() {
  console.log('🗺️  Fetching sitemap from Edge Function...');
  
  try {
    const response = await fetch(SITEMAP_EDGE_FUNCTION_URL);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
    }
    
    const sitemapXml = await response.text();
    
    // Count URLs in the sitemap
    const urlCount = (sitemapXml.match(/<url>/g) || []).length;
    
    // Write to file
    const fs = await import('fs');
    fs.writeFileSync(OUTPUT_PATH, sitemapXml);
    
    console.log(`✅ Sitemap generated successfully!`);
    console.log(`📊 Total URLs: ${urlCount}`);
    console.log(`📁 Output: ${OUTPUT_PATH}`);
    
    // Show breakdown
    const staticCount = 10 * 2; // 10 static pages × 2 languages (including /academies)
    const trainerMatches = sitemapXml.match(/\/trainer\//g) || [];
    const locationMatches = sitemapXml.match(/\/locations\//g) || [];
    const cityMatches = sitemapXml.match(/\/trainers\/[^<]+/g) || [];
    const academyMatches = sitemapXml.match(/\/academies\/[^<]+/g) || [];
    
    console.log('\n📈 Breakdown:');
    console.log(`   Static pages: ${staticCount}`);
    console.log(`   Trainer profiles: ${trainerMatches.length}`);
    console.log(`   Location pages: ${locationMatches.length}`);
    console.log(`   City landing pages: ${cityMatches.length - (sitemapXml.match(/\/trainers<\/loc>/g) || []).length}`);
    console.log(`   Academy pages: ${academyMatches.length}`);
    
  } catch (error) {
    console.error('❌ Error generating sitemap:', error);
    process.exit(1);
  }
}

generateSitemap();
