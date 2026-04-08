function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface QuizShareCardData {
  emoji: string;
  profileName: string;
  tagline: string;
  redFlags: string[];
  greenFlag: string;
  accentColor: string; // HSL string like "0 80% 50%"
}

export function buildQuizShareSvg(data: QuizShareCardData): string {
  const { emoji, profileName, tagline, redFlags, greenFlag, accentColor } = data;
  const accentHex = `hsl(${accentColor})`;

  return `<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)" rx="24"/>

  <!-- Logo -->
  <text x="540" y="70" fill="#ffffff" font-size="28" font-weight="700" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" letter-spacing="2">PADELTRAINER<tspan fill="#F97316">.</tspan><tspan fill="#f45d25">AI</tspan></text>

  <!-- Subtitle -->
  <text x="540" y="120" fill="#94A3B8" font-size="20" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">What's Your Padel Red Flag?</text>

  <!-- Accent line -->
  <rect x="440" y="150" width="200" height="4" rx="2" fill="${accentHex}" opacity="0.6"/>

  <!-- Emoji -->
  <text x="540" y="310" font-size="140" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${esc(emoji)}</text>

  <!-- Profile name -->
  <text x="540" y="420" fill="#ffffff" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" letter-spacing="-0.5">${esc(profileName)}</text>

  <!-- Tagline -->
  <text x="540" y="475" fill="#94A3B8" font-size="22" font-weight="400" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-style="italic">"${esc(tagline)}"</text>

  <!-- Red flags section -->
  <rect x="120" y="530" width="840" height="${160 + redFlags.length * 50}" rx="20" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>

  <text x="180" y="580" fill="#ffffff" font-size="24" font-weight="700" font-family="system-ui, -apple-system, sans-serif">🚩 Red Flags</text>
  ${redFlags.map((flag, i) => `
  <text x="200" y="${635 + i * 50}" fill="#CBD5E1" font-size="22" font-weight="400" font-family="system-ui, -apple-system, sans-serif">• ${esc(flag)}</text>
  `).join('')}

  <!-- Green flag section -->
  <rect x="120" y="${560 + redFlags.length * 50 + 50}" width="840" height="110" rx="20" fill="rgba(34,197,94,0.08)" stroke="rgba(34,197,94,0.15)" stroke-width="1"/>

  <text x="180" y="${560 + redFlags.length * 50 + 100}" fill="#ffffff" font-size="24" font-weight="700" font-family="system-ui, -apple-system, sans-serif">🟢 Green Flag</text>
  <text x="200" y="${560 + redFlags.length * 50 + 140}" fill="#86EFAC" font-size="22" font-weight="400" font-family="system-ui, -apple-system, sans-serif">${esc(greenFlag)}</text>

  <!-- Footer line -->
  <line x1="80" y1="1240" x2="1000" y2="1240" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="540" y="1300" fill="#64748B" font-size="18" text-anchor="middle" font-family="system-ui, sans-serif">Take the quiz at <tspan fill="#F97316" font-weight="600">padeltrainer.ai/playground/red-flag-quiz</tspan></text>
</svg>`;
}
