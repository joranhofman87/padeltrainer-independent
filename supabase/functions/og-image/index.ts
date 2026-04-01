import { corsHeaders } from '@supabase/supabase-js/cors';

const WIDTH = 1200;
const HEIGHT = 630;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const city = url.searchParams.get('city') || 'City';
  const count = url.searchParams.get('count') || '0';

  const svg = `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#16213e;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)" />
      <rect x="0" y="580" width="${WIDTH}" height="50" fill="#F97316" opacity="0.9" />
      <text x="60" y="280" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="white">
        Padel in ${escapeXml(city)}
      </text>
      <text x="60" y="350" font-family="Arial, Helvetica, sans-serif" font-size="32" fill="#94a3b8">
        ${escapeXml(count)} clubs &amp; courts
      </text>
      <text x="60" y="615" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="white">
        PadelTrainer.ai
      </text>
    </svg>
  `;

  // Return SVG as image
  return new Response(svg, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
});

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
