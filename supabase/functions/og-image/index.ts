// Dynamic OG image generator (SVG, 1200x630)
// Supports query params:
//   type=city|trainer|academy|club|article|generic (default: generic)
//   title=     primary headline
//   subtitle=  secondary line (e.g. "Padel coach in Utrecht", "12 reviews · 4.9★")
//   accent=    optional hex color (without #) for accent bar (default F97316)
//   eyebrow=   optional small label above the title
// Backwards compatible with the legacy ?city=&count= shape.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const WIDTH = 1200;
const HEIGHT = 630;

const ACCENTS: Record<string, string> = {
  trainer: '#F97316',
  academy: '#8B5CF6',
  club: '#10B981',
  article: '#3B82F6',
  city: '#F97316',
  generic: '#F97316',
};

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const params = url.searchParams;

  // Legacy shape: ?city=&count=
  let type = (params.get('type') || 'generic').toLowerCase();
  let title = params.get('title') || '';
  let subtitle = params.get('subtitle') || '';
  const eyebrow = params.get('eyebrow') || '';

  if (params.get('city')) {
    type = 'city';
    title = title || `Padel in ${params.get('city')}`;
    subtitle = subtitle || `${params.get('count') || '0'} clubs & courts`;
  }

  if (!title) title = 'PadelTrainer.ai';

  const accentParam = params.get('accent');
  const accent = accentParam ? `#${accentParam.replace(/^#/, '')}` : (ACCENTS[type] || ACCENTS.generic);

  const titleLines = wrapText(title, 26).slice(0, 2);
  const subtitleLines = wrapText(subtitle, 56).slice(0, 2);

  const titleSize = titleLines.length > 1 ? 70 : 84;
  const titleStartY = 290;

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#1E293B"/>
    </linearGradient>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.7"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <circle cx="1050" cy="120" r="220" fill="${accent}" opacity="0.08"/>
  <circle cx="1100" cy="540" r="180" fill="${accent}" opacity="0.06"/>
  ${eyebrow ? `<text x="60" y="160" font-family="Inter, Arial, Helvetica, sans-serif" font-size="26" font-weight="600" fill="${accent}" letter-spacing="2">${escapeXml(eyebrow.toUpperCase())}</text>` : ''}
  ${titleLines
    .map(
      (line, i) =>
        `<text x="60" y="${titleStartY + i * (titleSize + 8)}" font-family="Inter, Arial, Helvetica, sans-serif" font-size="${titleSize}" font-weight="800" fill="white">${escapeXml(line)}</text>`,
    )
    .join('\n  ')}
  ${subtitleLines
    .map(
      (line, i) =>
        `<text x="60" y="${480 + i * 44}" font-family="Inter, Arial, Helvetica, sans-serif" font-size="32" font-weight="400" fill="#94A3B8">${escapeXml(line)}</text>`,
    )
    .join('\n  ')}
  <rect x="0" y="585" width="${WIDTH}" height="45" fill="url(#accentGrad)"/>
  <text x="60" y="616" font-family="Inter, Arial, Helvetica, sans-serif" font-size="22" font-weight="700" fill="white">PadelTrainer.ai</text>
  <text x="${WIDTH - 60}" y="616" text-anchor="end" font-family="Inter, Arial, Helvetica, sans-serif" font-size="20" font-weight="500" fill="white" opacity="0.9">padeltrainer.ai</text>
</svg>`;

  return new Response(svg, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    },
  });
});

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, maxChars: number): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}
