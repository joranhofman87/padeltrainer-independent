import { format, differenceInMonths } from 'date-fns';

interface RatingEntry {
  rating: number;
  scraped_at: string;
}

interface ShareCardData {
  firstName: string;
  systemName: string;
  firstRating: number;
  latestRating: number;
  bestRating: number;
  improvement: number;
  isAtBest: boolean;
  months: number;
  startLabel: string;
  celebrationEmoji: string;
  celebrationText: string;
  badges: string[];
  chartPoints: string;
  areaPoints: string;
  firstDateLabel: string;
  lastDateLabel: string;
  minRating: number;
  maxRating: number;
}

function getCelebration(improvement: number, isAtBest: boolean): { emoji: string; text: string } {
  if (isAtBest && improvement > 0) return { emoji: '🏆', text: 'All-time beste rating!' };
  if (improvement >= 3) return { emoji: '🚀', text: `Ongelofelijk! ${improvement.toFixed(1)} punten verbeterd` };
  if (improvement >= 1) return { emoji: '📈', text: `Stijgende lijn! +${improvement.toFixed(1)} punten` };
  if (improvement > 0) return { emoji: '💪', text: 'Stap voor stap beter' };
  return { emoji: '📊', text: `${Math.abs(improvement).toFixed(1)} punten verschil sinds de start` };
}

function getBadges(improvement: number, months: number, isAtBest: boolean): string[] {
  const badges: string[] = [];
  if (improvement >= 3) badges.push('🔥 3+ punten verbeterd');
  if (months >= 12) badges.push('📅 1+ jaar actief');
  if (isAtBest && improvement > 0) badges.push('🏆 All-time high');
  return badges;
}

export function buildShareCardData(
  playerName: string,
  history: RatingEntry[],
  systemName: string,
  lowerIsBetter: boolean,
): ShareCardData | null {
  if (history.length === 0) return null;

  const firstName = playerName?.split(' ')[0] || 'Speler';
  const firstRating = history[0].rating;
  const latestRating = history[history.length - 1].rating;
  const rawDiff = Number((firstRating - latestRating).toFixed(2));
  const improvement = lowerIsBetter ? rawDiff : -rawDiff;

  const bestRating = lowerIsBetter
    ? Math.min(...history.map(e => e.rating))
    : Math.max(...history.map(e => e.rating));
  const isAtBest = latestRating === bestRating;

  const firstDate = new Date(history[0].scraped_at);
  const lastDate = new Date(history[history.length - 1].scraped_at);
  const months = differenceInMonths(lastDate, firstDate);

  const celebration = getCelebration(improvement, isAtBest);
  const badges = getBadges(improvement, months, isAtBest);

  // Chart geometry
  const chartW = 920, chartH = 300, pad = 24;
  const ratings = history.map(e => e.rating);
  const minR = Math.min(...ratings), maxR = Math.max(...ratings);
  const range = Math.max(maxR - minR, 1);
  const chartPoints = history.map((e, i) => {
    const x = pad + (i * (chartW - pad * 2)) / Math.max(history.length - 1, 1);
    const t = (e.rating - minR) / range;
    const y = chartH - pad - t * (chartH - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  const areaPoints = `${pad},${chartH - pad} ${chartPoints} ${chartW - pad},${chartH - pad}`;

  return {
    firstName,
    systemName,
    firstRating,
    latestRating,
    bestRating,
    improvement,
    isAtBest,
    months,
    startLabel: format(firstDate, "MMM ''yy").toLowerCase(),
    celebrationEmoji: celebration.emoji,
    celebrationText: celebration.text,
    badges,
    chartPoints,
    areaPoints,
    firstDateLabel: format(firstDate, "MMM ''yy"),
    lastDateLabel: format(lastDate, "MMM ''yy"),
    minRating: minR,
    maxRating: maxR,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildShareCardSvg(data: ShareCardData): string {
  const { firstName, systemName, firstRating, latestRating, bestRating, improvement, celebrationEmoji, celebrationText, badges, chartPoints, areaPoints, firstDateLabel, lastDateLabel, minRating, maxRating, months, startLabel } = data;

  const improvementBadgeSvg = improvement !== 0 ? `
    <rect x="${540 - 200}" y="530" width="400" height="60" rx="30" fill="${improvement > 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}" stroke="${improvement > 0 ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}" stroke-width="1"/>
    <text x="540" y="568" fill="${improvement > 0 ? '#22C55E' : '#EF4444'}" font-size="26" font-weight="700" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${esc(celebrationEmoji)} ${esc(celebrationText)}</text>
  ` : '';

  const badgesSvg = badges.map((badge, i) => {
    const bw = badge.length * 11 + 40;
    const totalW = badges.reduce((s, b) => s + b.length * 11 + 40 + 12, -12);
    const startX = 540 - totalW / 2;
    const x = startX + badges.slice(0, i).reduce((s, b) => s + b.length * 11 + 40 + 12, 0);
    return `
      <rect x="${x}" y="1090" width="${bw}" height="44" rx="22" fill="rgba(249,115,22,0.12)" stroke="rgba(249,115,22,0.25)" stroke-width="1"/>
      <text x="${x + bw / 2}" y="1118" fill="#F97316" font-size="15" font-weight="600" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${esc(badge)}</text>
    `;
  }).join('');

  // Scale chart to card coordinates
  const chartAreaX = 80, chartAreaY = 620, chartAreaW = 920, chartAreaH = 400;

  return `<svg width="1080" height="1350" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
    <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F97316" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#F97316" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1350" fill="url(#bg)" rx="24"/>

  <!-- Logo (text-based for reliable canvas rendering) -->
  <text x="540" y="60" fill="#ffffff" font-size="28" font-weight="700" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" letter-spacing="2">PADELTRAINER<tspan fill="#F97316">.</tspan><tspan fill="#f45d25">AI</tspan></text>

  <!-- Player name -->
  <text x="540" y="160" fill="#ffffff" font-size="48" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" letter-spacing="-0.5">${esc(firstName)}</text>
  <text x="540" y="200" fill="#94A3B8" font-size="22" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Padel Rating Voortgang · ${esc(systemName)}</text>

  <!-- Stats boxes -->
  <rect x="80" y="240" width="280" height="130" rx="16" fill="rgba(255,255,255,0.08)"/>
  <text x="220" y="310" fill="#ffffff" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${firstRating.toFixed(1)}</text>
  <text x="220" y="345" fill="#94A3B8" font-size="16" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Start</text>

  <rect x="400" y="240" width="280" height="130" rx="16" fill="rgba(255,255,255,0.08)"/>
  <text x="540" y="310" fill="#ffffff" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${latestRating.toFixed(1)}</text>
  <text x="540" y="345" fill="#94A3B8" font-size="16" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Nu</text>

  <rect x="720" y="240" width="280" height="130" rx="16" fill="rgba(249,115,22,0.12)"/>
  <text x="860" y="310" fill="#F97316" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${bestRating.toFixed(1)}</text>
  <text x="860" y="345" fill="#F97316" font-size="16" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Beste</text>

  <!-- Improvement badge -->
  ${improvementBadgeSvg}

  <!-- Chart area background -->
  <rect x="${chartAreaX}" y="${chartAreaY}" width="${chartAreaW}" height="${chartAreaH}" rx="16" fill="rgba(255,255,255,0.04)"/>
  
  <!-- Chart (embedded SVG to use viewBox scaling) -->
  <svg x="${chartAreaX}" y="${chartAreaY}" width="${chartAreaW}" height="${chartAreaH}" viewBox="0 0 920 300" preserveAspectRatio="none">
    <polygon points="${areaPoints}" fill="url(#chartFill)"/>
    <polyline points="${chartPoints}" fill="none" stroke="#F97316" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>

  <!-- Chart labels -->
  <text x="${chartAreaX + 24}" y="${chartAreaY + chartAreaH + 25}" fill="#475569" font-size="14" text-anchor="start" font-family="system-ui, sans-serif">${esc(firstDateLabel)}</text>
  <text x="${chartAreaX + chartAreaW - 24}" y="${chartAreaY + chartAreaH + 25}" fill="#475569" font-size="14" text-anchor="end" font-family="system-ui, sans-serif">${esc(lastDateLabel)}</text>
  <text x="${chartAreaX - 8}" y="${chartAreaY + 20}" fill="#475569" font-size="13" text-anchor="end" font-family="system-ui, sans-serif">${maxRating.toFixed(1)}</text>
  <text x="${chartAreaX - 8}" y="${chartAreaY + chartAreaH - 5}" fill="#475569" font-size="13" text-anchor="end" font-family="system-ui, sans-serif">${minRating.toFixed(1)}</text>

  <!-- Milestone badges -->
  ${badgesSvg}

  <!-- Time stat -->
  <text x="540" y="1170" fill="#64748B" font-size="16" text-anchor="middle" font-family="system-ui, sans-serif">Sinds ${esc(startLabel)} actief · ${months} maanden progressie</text>

  <!-- Footer line -->
  <line x1="80" y1="1240" x2="1000" y2="1240" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <text x="540" y="1300" fill="#64748B" font-size="18" text-anchor="middle" font-family="system-ui, sans-serif">Track jouw rating op <tspan fill="#F97316" font-weight="600">padeltrainer.ai</tspan></text>
</svg>`;
}

export async function svgToPngBlob(svgString: string, width = 1080, height = 1350): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * 2; // 2x for retina
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load SVG image'));
    };
    img.src = url;
  });
}
