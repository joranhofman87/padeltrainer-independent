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

  <!-- Logo -->
  <image x="240" y="30" width="600" height="72" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMjAwMCIgem9vbUFuZFBhbj0ibWFnbmlmeSIgdmlld0JveD0iMCA2NjAgMTUwMCAxODAiIGhlaWdodD0iMTgwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWlkWU1pZCBtZWV0IiB2ZXJzaW9uPSIxLjAiPjxkZWZzPjxnLz48L2RlZnM+PGcgZmlsbD0iI2ZmZmZmZiIgZmlsbC1vcGFjaXR5PSIxIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMjEuNzQwMjU4LCA4MTMuMzc3ODM4KSI+PGc+PHBhdGggZD0iTSAzOS4wNDY4NzUgLTQ2LjU5Mzc1IEwgMzkuMDQ2ODc1IDAgTCAxMS44MTI1IDAgTCAxMS44MTI1IC0xMzIuMjM0Mzc1IEwgNjMuMzkwNjI1IC0xMzIuMjM0Mzc1IEMgNzMuMzE2NDA2IC0xMzIuMjM0Mzc1IDgyLjA1MDc4MSAtMTMwLjQxNDA2MiA4OS41OTM3NSAtMTI2Ljc4MTI1IEMgOTcuMTMyODEyIC0xMjMuMTU2MjUgMTAyLjkyOTY4OCAtMTE3Ljk5MjE4OCAxMDYuOTg0Mzc1IC0xMTEuMjk2ODc1IEMgMTExLjA0Njg3NSAtMTA0LjYwOTM3NSAxMTMuMDc4MTI1IC05Ni45OTIxODggMTEzLjA3ODEyNSAtODguNDUzMTI1IEMgMTEzLjA3ODEyNSAtNzUuNTAzOTA2IDEwOC42NDA2MjUgLTY1LjI4OTA2MiA5OS43NjU2MjUgLTU3LjgxMjUgQyA5MC44OTg0MzggLTUwLjMzMjAzMSA3OC42MjUgLTQ2LjU5Mzc1IDYyLjkzNzUgLTQ2LjU5Mzc1IFogTSAzOS4wNDY4NzUgLTY4LjY1NjI1IEwgNjMuMzkwNjI1IC02OC42NTYyNSBDIDcwLjU5NzY1NiAtNjguNjU2MjUgNzYuMDkzNzUgLTcwLjM0NzY1NiA3OS44NzUgLTczLjczNDM3NSBDIDgzLjY1NjI1IC03Ny4xMjg5MDYgODUuNTQ2ODc1IC04MS45NzY1NjIgODUuNTQ2ODc1IC04OC4yODEyNSBDIDg1LjU0Njg3NSAtOTQuNzU3ODEyIDgzLjY0MDYyNSAtOTkuOTkyMTg4IDc5LjgyODEyNSAtMTAzLjk4NDM3NSBDIDc2LjAxNTYyNSAtMTA3Ljk4NDM3NSA3MC43NSAtMTEwLjA0Njg3NSA2NC4wMzEyNSAtMTEwLjE3MTg3NSBMIDM5LjA0Njg3NSAtMTEwLjE3MTg3NSBaIE0gMzkuMDQ2ODc1IC02OC42NTYyNSAiLz48L2c+PC9nPjwvZz48ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLW9wYWNpdHk9IjEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDI0MC43MDczNSwgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gNjcuMDMxMjUgMCBDIDY1LjgxMjUgLTIuMzYzMjgxIDY0LjkyOTY4OCAtNS4zMDA3ODEgNjQuMzkwNjI1IC04LjgxMjUgQyA1OC4wMzUxNTYgLTEuNzI2NTYyIDQ5Ljc2OTUzMSAxLjgxMjUgMzkuNTkzNzUgMS44MTI1IEMgMjkuOTY4NzUgMS44MTI1IDIxLjk4ODI4MSAtMC45Njg3NSAxNS42NTYyNSAtNi41MzEyNSBDIDkuMzMyMDMxIC0xMi4xMDE1NjIgNi4xNzE4NzUgLTE5LjEyODkwNiA2LjE3MTg3NSAtMjcuNjA5Mzc1IEMgNi4xNzE4NzUgLTM4LjAyMzQzOCAxMC4wMzEyNSAtNDYuMDE1NjI1IDE3Ljc1IC01MS41NzgxMjUgQyAyNS40Njg3NSAtNTcuMTQ4NDM4IDM2LjYyNSAtNTkuOTY4NzUgNTEuMjE4NzUgLTYwLjAzMTI1IEwgNjMuMjk2ODc1IC02MC4wMzEyNSBMIDYzLjI5Njg3NSAtNjUuNjU2MjUgQyA2My4yOTY4NzUgLTcwLjE5NTMxMiA2Mi4xMjg5MDYgLTczLjgzMjAzMSA1OS43OTY4NzUgLTc2LjU2MjUgQyA1Ny40NzI2NTYgLTc5LjI4OTA2MiA1My43OTY4NzUgLTgwLjY1NjI1IDQ4Ljc2NTYyNSAtODAuNjU2MjUgQyA0NC4zNDc2NTYgLTgwLjY1NjI1IDQwLjg4MjgxMiAtNzkuNTkzNzUgMzguMzc1IC03Ny40Njg3NSBDIDM1Ljg2MzI4MSAtNzUuMzUxNTYyIDM0LjYwOTM3NSAtNzIuNDQ1MzEyIDM0LjYwOTM3NSAtNjguNzUgTCA4LjM1OTM3NSAtNjguNzUgQyA4LjM1OTM3NSAtNzQuNDM3NSAxMC4xMTMyODEgLTc5LjcwMzEyNSAxMy42MjUgLTg0LjU0Njg3NSBDIDE3LjEzMjgxMiAtODkuMzkwNjI1IDIyLjA5NzY1NiAtOTMuMTg3NSAyOC41MTU2MjUgLTk1LjkzNzUgQyAzNC45Mjk2ODggLTk4LjY5NTMxMiA0Mi4xNDA2MjUgLTEwMC4wNzgxMjUgNTAuMTQwNjI1IC0xMDAuMDc4MTI1IEMgNjIuMjQyMTg4IC0xMDAuMDc4MTI1IDcxLjg1MTU2MiAtOTcuMDM1MTU2IDc4Ljk2ODc1IC05MC45NTMxMjUgQyA4Ni4wODIwMzEgLTg0Ljg2NzE4OCA4OS42NDA2MjUgLTc2LjMxNjQwNiA4OS42NDA2MjUgLTY1LjI5Njg3NSBMIDg5LjY0MDYyNSAtMjIuNzAzMTI1IEMgODkuNzAzMTI1IC0xMy4zNzg5MDYgOTEuMDAzOTA2IC02LjMyODEyNSA5My41NDY4NzUgLTEuNTQ2ODc1IEwgOTMuNTQ2ODc1IDAgWiBNIDQ1LjMxMjUgLTE4LjI1IEMgNDkuMTg3NSAtMTguMjUgNTIuNzU3ODEyIC0xOS4xMTMyODEgNTYuMDMxMjUgLTIwLjg0Mzc1IEMgNTkuMzAwNzgxIC0yMi41NzAzMTIgNjEuNzIyNjU2IC0yNC44OTA2MjUgNjMuMjk2ODc1IC0yNy43OTY4NzUgTCA2My4yOTY4NzUgLTQ0LjY4NzUgTCA1My41IC00NC42ODc1IEMgNDAuMzUxNTYyIC00NC42ODc1IDMzLjM1OTM3NSAtNDAuMTQ0NTMxIDMyLjUxNTYyNSAtMzEuMDYyNSBMIDMyLjQyMTg3NSAtMjkuNTE1NjI1IEMgMzIuNDIxODc1IC0yNi4yNDIxODggMzMuNTcwMzEyIC0yMy41NDY4NzUgMzUuODc1IC0yMS40MjE4NzUgQyAzOC4xNzU3ODEgLTE5LjMwNDY4OCA0MS4zMjAzMTIgLTE4LjI1IDQ1LjMxMjUgLTE4LjI1IFogTSA0NS4zMTI1IC0xOC4yNSAiLz48L2c+PC9nPjwvZz48ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLW9wYWNpdHk9IjEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM0MC40MjE3NzMsIDgxMy4zNzc4MzgpIj48Zz48cGF0aCBkPSJNIDYgLTQ5Ljg1OTM3NSBDIDYgLTY1LjE3OTY4OCA5LjQyOTY4OCAtNzcuMzc4OTA2IDE2LjI5Njg3NSAtODYuNDUzMTI1IEMgMjMuMTcxODc1IC05NS41MzUxNTYgMzIuNTcwMzEyIC0xMDAuMDc4MTI1IDQ0LjUgLTEwMC4wNzgxMjUgQyA1NC4wNzAzMTIgLTEwMC4wNzgxMjUgNjEuOTcyNjU2IC05Ni41MDc4MTIgNjguMjAzMTI1IC04OS4zNzUgTCA2OC4yMDMxMjUgLTEzOS41IEwgOTQuNTQ2ODc1IC0xMzkuNSBMIDk0LjU0Njg3NSAwIEwgNzAuODQzNzUgMCBMIDY5LjU2MjUgLTEwLjQzNzUgQyA2My4wMzEyNSAtMi4yNjk1MzEgNTQuNjE3MTg4IDEuODEyNSA0NC4zMjgxMjUgMS44MTI1IEMgMzIuNzUzOTA2IDEuODEyNSAyMy40NzI2NTYgLTIuNzM4MjgxIDE2LjQ4NDM3NSAtMTEuODQzNzUgQyA5LjQ5MjE4OCAtMjAuOTU3MDMxIDYgLTMzLjYyODkwNiA2IC00OS44NTkzNzUgWiBNIDMyLjIzNDM3NSAtNDcuOTUzMTI1IEMgMzIuMjM0Mzc1IC0zOC43NTM5MDYgMzMuODM1OTM4IC0zMS43MDMxMjUgMzcuMDQ2ODc1IC0yNi43OTY4NzUgQyA0MC4yNjU2MjUgLTIxLjg5MDYyNSA0NC45Mjk2ODggLTE5LjQzNzUgNTEuMDQ2ODc1IC0xOS40Mzc1IEMgNTkuMTYwMTU2IC0xOS40Mzc1IDY0Ljg3ODkwNiAtMjIuODU5Mzc1IDY4LjIwMzEyNSAtMjkuNzAzMTI1IEwgNjguMjAzMTI1IC02OC40ODQzNzUgQyA2NC45Mjk2ODggLTc1LjMxNjQwNiA1OS4yNjk1MzEgLTc4LjczNDM3NSA1MS4yMTg3NSAtNzguNzM0Mzc1IEMgMzguNTYyNSAtNzguNzM0Mzc1IDMyLjIzNDM3NSAtNjguNDcyNjU2IDMyLjIzNDM3NSAtNDcuOTUzMTI1IFogTSAzMi4yMzQzNzUgLTQ3Ljk1MzEyNSAiLz48L2c+PC9nPjwvZz48ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLW9wYWNpdHk9IjEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDQ0NS4yMjE3OSwgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gNTUuMzEyNSAxLjgxMjUgQyA0MC44OTQ1MzEgMS44MTI1IDI5LjE2MDE1NiAtMi42MDE1NjIgMjAuMTA5Mzc1IC0xMS40Mzc1IEMgMTEuMDY2NDA2IC0yMC4yODEyNSA2LjU0Njg3NSAtMzIuMDU0Njg4IDYuNTQ2ODc1IC00Ni43NjU2MjUgTCA2LjU0Njg3NSAtNDkuMzEyNSBDIDYuNTQ2ODc1IC01OS4xODc1IDguNDUzMTI1IC02OC4wMDc4MTIgMTIuMjY1NjI1IC03NS43ODEyNSBDIDE2LjA3ODEyNSAtODMuNTYyNSAyMS40NzY1NjIgLTg5LjU1NDY4OCAyOC40Njg3NSAtOTMuNzY1NjI1IEMgMzUuNDY4NzUgLTk3Ljk3MjY1NiA0My40NDUzMTIgLTEwMC4wNzgxMjUgNTIuNDA2MjUgLTEwMC4wNzgxMjUgQyA2NS44NDM3NSAtMTAwLjA3ODEyNSA3Ni40MjE4NzUgLTk1LjgzNTkzOCA4NC4xNDA2MjUgLTg3LjM1OTM3NSBDIDkxLjg1OTM3NSAtNzguODkwNjI1IDk1LjcxODc1IC02Ni44NzUgOTUuNzE4NzUgLTUxLjMxMjUgTCA5NS43MTg3NSAtNDAuNTkzNzUgTCAzMy4xNTYyNSAtNDAuNTkzNzUgQyAzNCAtMzQuMTc1NzgxIDM2LjU1NDY4OCAtMjkuMDMxMjUgNDAuODI4MTI1IC0yNS4xNTYyNSBDIDQ1LjA5NzY1NiAtMjEuMjgxMjUgNTAuNSAtMTkuMzQzNzUgNTcuMDMxMjUgLTE5LjM0Mzc1IEMgNjcuMTQ0NTMxIC0xOS4zNDM3NSA3NS4wNDY4NzUgLTIzLjAwMzkwNiA4MC43MzQzNzUgLTMwLjMyODEyNSBMIDkzLjY0MDYyNSAtMTUuODkwNjI1IEMgODkuNzAzMTI1IC0xMC4zMTY0MDYgODQuMzc1IC01Ljk3MjY1NiA3Ny42NTYyNSAtMi44NTkzNzUgQyA3MC45Mzc1IDAuMjUzOTA2IDYzLjQ4ODI4MSAxLjgxMjUgNTUuMzEyNSAxLjgxMjUgWiBNIDUyLjMxMjUgLTc4LjgyODEyNSBDIDQ3LjEwMTU2MiAtNzguODI4MTI1IDQyLjg3ODkwNiAtNzcuMDcwMzEyIDM5LjY0MDYyNSAtNzMuNTYyNSBDIDM2LjM5ODQzOCAtNzAuMDUwNzgxIDM0LjMyODEyNSAtNjUuMDIzNDM4IDMzLjQyMTg3NSAtNTguNDg0Mzc1IEwgNjkuOTM3NSAtNTguNDg0Mzc1IEwgNjkuOTM3NSAtNjAuNTc4MTI1IEMgNjkuODEyNSAtNjYuMzkwNjI1IDY4LjIzNDM3NSAtNzAuODgyODEyIDY1LjIwMzEyNSAtNzQuMDYyNSBDIDYyLjE3OTY4OCAtNzcuMjM4MjgxIDU3Ljg4MjgxMiAtNzguODI4MTI1IDUyLjMxMjUgLTc4LjgyODEyNSBaIE0gNTIuMzEyNSAtNzguODI4MTI1ICIvPjwvZz48L2c+PC9nPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNTQ1Ljc1MzUyNywgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gMzcuNzgxMjUgMCBMIDExLjQzNzUgMCBMIDExLjQzNzUgLTEzOS41IEwgMzcuNzgxMjUgLTEzOS41IFogTSAzNy43ODEyNSAwICIvPjwvZz48L2c+PC9nPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNTk1LjA2NTg0LCA4MTMuMzc3ODM4KSI+PGc+PHBhdGggZD0iTSAxMTEuMzQzNzUgLTExMC4xNzE4NzUgTCA3MC44NDM3NSAtMTEwLjE3MTg3NSBMIDcwLjg0Mzc1IDAgTCA0My41OTM3NSAwIEwgNDMuNTkzNzUgLTExMC4xNzE4NzUgTCAzLjY0MDYyNSAtMTEwLjE3MTg3NSBMIDMuNjQwNjI1IC0xMzIuMjM0Mzc1IEwgMTExLjM0Mzc1IC0xMzIuMjM0Mzc1IFogTSAxMTEuMzQzNzUgLTExMC4xNzE4NzUgIi8+PC9nPjwvZz48L2c+PGcgZmlsbD0iI2ZmZmZmZiIgZmlsbC1vcGFjaXR5PSIxIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3MDQuMjI0ODg4LCA4MTMuMzc3ODM4KSI+PGc+PHBhdGggZD0iTSA2NS4yOTY4NzUgLTczLjY1NjI1IEMgNjEuNzIyNjU2IC03NC4xMzI4MTIgNTguNTc4MTI1IC03NC4zNzUgNTUuODU5Mzc1IC03NC4zNzUgQyA0NS45MjE4NzUgLTc0LjM3NSAzOS40MTAxNTYgLTcxLjAxNTYyNSAzNi4zMjgxMjUgLTY0LjI5Njg3NSBMIDM2LjMyODEyNSAwIEwgMTAuMDc4MTI1IDAgTCAxMC4wNzgxMjUgLTk4LjI2NTYyNSBMIDM0Ljg3NSAtOTguMjY1NjI1IEwgMzUuNjA5Mzc1IC04Ni41NDY4NzUgQyA0MC44NjcxODggLTk1LjU2NjQwNiA0OC4xNjAxNTYgLTEwMC4wNzgxMjUgNTcuNDg0Mzc1IC0xMDAuMDc4MTI1IEMgNjAuMzkwNjI1IC0xMDAuMDc4MTI1IDYzLjExMzI4MSAtOTkuNjg3NSA2NS42NTYyNSAtOTguOTA2MjUgWiBNIDY1LjI5Njg3NSAtNzMuNjU2MjUgIi8+PC9nPjwvZz48L2c+PGcgZmlsbD0iI2ZmZmZmZiIgZmlsbC1vcGFjaXR5PSIxIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3NjkuMzM4ODgxLCA4MTMuMzc3ODM4KSI+PGc+PHBhdGggZD0iTSA2Ny4wMzEyNSAwIEMgNjUuODEyNSAtMi4zNjMyODEgNjQuOTI5Njg4IC01LjMwMDc4MSA2NC4zOTA2MjUgLTguODEyNSBDIDU4LjAzNTE1NiAtMS43MjY1NjIgNDkuNzY5NTMxIDEuODEyNSAzOS41OTM3NSAxLjgxMjUgQyAyOS45Njg3NSAxLjgxMjUgMjEuOTg4MjgxIC0wLjk2ODc1IDE1LjY1NjI1IC02LjUzMTI1IEMgOS4zMzIwMzEgLTEyLjEwMTU2MiA2LjE3MTg3NSAtMTkuMTI4OTA2IDYuMTcxODc1IC0yNy42MDkzNzUgQyA2LjE3MTg3NSAtMzguMDIzNDM4IDEwLjAzMTI1IC00Ni4wMTU2MjUgMTcuNzUgLTUxLjU3ODEyNSBDIDI1LjQ2ODc1IC01Ny4xNDg0MzggMzYuNjI1IC01OS45Njg3NSA1MS4yMTg3NSAtNjAuMDMxMjUgTCA2My4yOTY4NzUgLTYwLjAzMTI1IEwgNjMuMjk2ODc1IC02NS42NTYyNSBDIDYzLjI5Njg3NSAtNzAuMTk1MzEyIDYyLjEyODkwNiAtNzMuODMyMDMxIDU5Ljc5Njg3NSAtNzYuNTYyNSBDIDU3LjQ3MjY1NiAtNzkuMjg5MDYyIDUzLjc5Njg3NSAtODAuNjU2MjUgNDguNzY1NjI1IC04MC42NTYyNSBDIDQ0LjM0NzY1NiAtODAuNjU2MjUgNDAuODgyODEyIC03OS41OTM3NSAzOC4zNzUgLTc3LjQ2ODc1IEMgMzUuODYzMjgxIC03NS4zNTE1NjIgMzQuNjA5Mzc1IC03Mi40NDUzMTIgMzQuNjA5Mzc1IC02OC43NSBMIDguMzU5Mzc1IC02OC43NSBDIDguMzU5Mzc1IC03NC40Mzc1IDEwLjExMzI4MSAtNzkuNzAzMTI1IDEzLjYyNSAtODQuNTQ2ODc1IEMgMTcuMTMyODEyIC04OS4zOTA2MjUgMjIuMDk3NjU2IC05My4xODc1IDI4LjUxNTYyNSAtOTUuOTM3NSBDIDM0LjkyOTY4OCAtOTguNjk1MzEyIDQyLjE0MDYyNSAtMTAwLjA3ODEyNSA1MC4xNDA2MjUgLTEwMC4wNzgxMjUgQyA2Mi4yNDIxODggLTEwMC4wNzgxMjUgNzEuODUxNTYyIC05Ny4wMzUxNTYgNzguOTY4NzUgLTkwLjk1MzEyNSBDIDg2LjA4MjAzMSAtODQuODY3MTg4IDg5LjY0MDYyNSAtNzYuMzE2NDA2IDg5LjY0MDYyNSAtNjUuMjk2ODc1IEwgODkuNjQwNjI1IC0yMi43MDMxMjUgQyA4OS43MDMxMjUgLTEzLjM3ODkwNiA5MS4wMDM5MDYgLTYuMzI4MTI1IDkzLjU0Njg3NSAtMS41NDY4NzUgTCA5My41NDY4NzUgMCBaIE0gNDUuMzEyNSAtMTguMjUgQyA0OS4xODc1IC0xOC4yNSA1Mi43NTc4MTIgLTE5LjExMzI4MSA1Ni4wMzEyNSAtMjAuODQzNzUgQyA1OS4zMDA3ODEgLTIyLjU3MDMxMiA2MS43MjI2NTYgLTI0Ljg5MDYyNSA2My4yOTY4NzUgLTI3Ljc5Njg3NSBMIDYzLjI5Njg3NSAtNDQuNjg3NSBMIDUzLjUgLTQ0LjY4NzUgQyA0MC4zNTE1NjIgLTQ0LjY4NzUgMzMuMzU5Mzc1IC00MC4xNDQ1MzEgMzIuNTE1NjI1IC0zMS4wNjI1IEwgMzIuNDIxODc1IC0yOS41MTU2MjUgQyAzMi40MjE4NzUgLTI2LjI0MjE4OCAzMy41NzAzMTIgLTIzLjU0Njg3NSAzNS44NzUgLTIxLjQyMTg3NSBDIDM4LjE3NTc4MSAtMTkuMzA0Njg4IDQxLjMyMDMxMiAtMTguMjUgNDUuMzEyNSAtMTguMjUgWiBNIDQ1LjMxMjUgLTE4LjI1ICIvPjwvZz48L2c+PC9nPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoODY5LjA1MzMwNSwgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gMzcuNzgxMjUgMCBMIDExLjQzNzUgMCBMIDExLjQzNzUgLTk4LjI2NTYyNSBMIDM3Ljc4MTI1IC05OC4yNjU2MjUgWiBNIDkuOTA2MjUgLTEyMy43MDMxMjUgQyA5LjkwNjI1IC0xMjcuNjI4OTA2IDExLjIxODc1IC0xMzAuODYzMjgxIDEzLjg0Mzc1IC0xMzMuNDA2MjUgQyAxNi40NzY1NjIgLTEzNS45NTcwMzEgMjAuMDY2NDA2IC0xMzcuMjM0Mzc1IDI0LjYwOTM3NSAtMTM3LjIzNDM3NSBDIDI5LjA4NTkzOCAtMTM3LjIzNDM3NSAzMi42NjAxNTYgLTEzNS45NTcwMzEgMzUuMzI4MTI1IC0xMzMuNDA2MjUgQyAzNy45OTIxODggLTEzMC44NjMyODEgMzkuMzI4MTI1IC0xMjcuNjI4OTA2IDM5LjMyODEyNSAtMTIzLjcwMzEyNSBDIDM5LjMyODEyNSAtMTE5LjcwMzEyNSAzNy45NzY1NjIgLTExNi40Mjk2ODggMzUuMjgxMjUgLTExMy44OTA2MjUgQyAzMi41OTM3NSAtMTExLjM0NzY1NiAyOS4wMzUxNTYgLTExMC4wNzgxMjUgMjQuNjA5Mzc1IC0xMTAuMDc4MTI1IEMgMjAuMTkxNDA2IC0xMTAuMDc4MTI1IDE2LjYzMjgxMiAtMTExLjM0NzY1NiAxMy45Mzc1IC0xMTMuODkwNjI1IEMgMTEuMjUgLTExNi40Mjk2ODggOS45MDYyNSAtMTE5LjcwMzEyNSA5LjkwNjI1IC0xMjMuNzAzMTI1IFogTSA5LjkwNjI1IC0xMjMuNzAzMTI1ICIvPjwvZz48L2c+PC9nPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOTE4LjM2NTYxNywgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gMzQuMjM0Mzc1IC05OC4yNjU2MjUgTCAzNS4wNjI1IC04Ni45MjE4NzUgQyA0Mi4wODIwMzEgLTk1LjY5MTQwNiA1MS40OTIxODggLTEwMC4wNzgxMjUgNjMuMjk2ODc1IC0xMDAuMDc4MTI1IEMgNzMuNzEwOTM4IC0xMDAuMDc4MTI1IDgxLjQ2MDkzOCAtOTcuMDE5NTMxIDg2LjU0Njg3NSAtOTAuOTA2MjUgQyA5MS42NDA2MjUgLTg0Ljc4OTA2MiA5NC4yNDIxODggLTc1LjY0ODQzOCA5NC4zNTkzNzUgLTYzLjQ4NDM3NSBMIDM0LjIzNDM3NSAtOTguMjY1NjI1ICIvPjwvZz48L2c+PC9nPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMSI+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTAyMi41Mjk5MTUsIDgxMy4zNzc4MzgpIj48Zz48cGF0aCBkPSJNIDU1LjMxMjUgMS44MTI1IEMgNDAuODk0NTMxIDEuODEyNSAyOS4xNjAxNTYgLTIuNjAxNTYyIDIwLjEwOTM3NSAtMTEuNDM3NSBDIDExLjA2NjQwNiAtMjAuMjgxMjUgNi41NDY4NzUgLTMyLjA1NDY4OCA2LjU0Njg3NSAtNDYuNzY1NjI1IEwgNi41NDY4NzUgLTQ5LjMxMjUgQyA2LjU0Njg3NSAtNTkuMTg3NSA4LjQ1MzEyNSAtNjguMDA3ODEyIDEyLjI2NTYyNSAtNzUuNzgxMjUgQyAxNi4wNzgxMjUgLTgzLjU2MjUgMjEuNDc2NTYyIC04OS41NTQ2ODggMjguNDY4NzUgLTkzLjc2NTYyNSBDIDM1LjQ2ODc1IC05Ny45NzI2NTYgNDMuNDQ1MzEyIC0xMDAuMDc4MTI1IDUyLjQwNjI1IC0xMDAuMDc4MTI1IEMgNjUuODQzNzUgLTEwMC4wNzgxMjUgNzYuNDIxODc1IC05NS44MzU5MzggODQuMTQwNjI1IC04Ny4zNTkzNzUgQyA5MS44NTkzNzUgLTc4Ljg5MDYyNSA5NS43MTg3NSAtNjYuODc1IDk1LjcxODc1IC01MS4zMTI1IEwgOTUuNzE4NzUgLTQwLjU5Mzc1IEwgMzMuMTU2MjUgLTQwLjU5Mzc1IEMgMzQgLTM0LjE3NTc4MSAzNi41NTQ2ODggLTI5LjAzMTI1IDQwLjgyODEyNSAtMjUuMTU2MjUgQyA0NS4wOTc2NTYgLTIxLjI4MTI1IDUwLjUgLTE5LjM0Mzc1IDU3LjAzMTI1IC0xOS4zNDM3NSBDIDY3LjE0NDUzMSAtMTkuMzQzNzUgNzUuMDQ2ODc1IC0yMy4wMDM5MDYgODAuNzM0Mzc1IC0zMC4zMjgxMjUgTCA5My42NDA2MjUgLTE1Ljg5MDYyNSBDIDg5LjcwMzEyNSAtMTAuMzE2NDA2IDg0LjM3NSAtNS45NzI2NTYgNzcuNjU2MjUgLTIuODU5Mzc1IEMgNzAuOTM3NSAwLjI1MzkwNiA2My40ODgyODEgMS44MTI1IDU1LjMxMjUgMS44MTI1IFogTSA1Mi4zMTI1IC03OC44MjgxMjUgQyA0Ny4xMDE1NjIgLTc4LjgyODEyNSA0Mi44Nzg5MDYgLTc3LjA3MDMxMiAzOS42NDA2MjUgLTczLjU2MjUgQyAzNi4zOTg0MzggLTcwLjA1MDc4MSAzNC4zMjgxMjUgLTY1LjAyMzQzOCAzMy40MjE4NzUgLTU4LjQ4NDM3NSBMIDY5LjkzNzUgLTU4LjQ4NDM3NSBMIDY5LjkzNzUgLTYwLjU3ODEyNSBDIDY5LjgxMjUgLTY2LjM5MDYyNSA2OC4yMzQzNzUgLTcwLjg4MjgxMiA2NS4yMDMxMjUgLTc0LjA2MjUgQyA2Mi4xNzk2ODggLTc3LjIzODI4MSA1Ny44ODI4MTIgLTc4LjgyODEyNSA1Mi4zMTI1IC03OC44MjgxMjUgWiBNIDUyLjMxMjUgLTc4LjgyODEyNSAiLz48L2c+PC9nPjwvZz48ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLW9wYWNpdHk9IjEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDExMjMuMDYxNjc1LCA4MTMuMzc3ODM4KSI+PGc+PHBhdGggZD0iTSA2NS4yOTY4NzUgLTczLjY1NjI1IEMgNjEuNzIyNjU2IC03NC4xMzI4MTIgNTguNTc4MTI1IC03NC4zNzUgNTUuODU5Mzc1IC03NC4zNzUgQyA0NS45MjE4NzUgLTc0LjM3NSAzOS40MTAxNTYgLTcxLjAxNTYyNSAzNi4zMjgxMjUgLTY0LjI5Njg3NSBMIDM2LjMyODEyNSAwIEwgMTAuMDc4MTI1IDAgTCAxMC4wNzgxMjUgLTk4LjI2NTYyNSBMIDM0Ljg3NSAtOTguMjY1NjI1IEwgMzUuNjA5Mzc1IC04Ni41NDY4NzUgQyA0MC44NjcxODggLTk1LjU2NjQwNiA0OC4xNjAxNTYgLTEwMC4wNzgxMjUgNTcuNDg0Mzc1IC0xMDAuMDc4MTI1IEMgNjAuMzkwNjI1IC0xMDAuMDc4MTI1IDYzLjExMzI4MSAtOTkuNjg3NSA2NS42NTYyNSAtOTguOTA2MjUgWiBNIDY1LjI5Njg3NSAtNzMuNjU2MjUgIi8+PC9nPjwvZz48L2c+PGcgZmlsbD0iI2ZmZmZmZiIgZmlsbC1vcGFjaXR5PSIxIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMTc1LjE4ODg2OCwgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gMTEuNDM3NSAtMTIuODkwNjI1IEMgMTEuNDM3NSAtMTcuMDY2NDA2IDEyLjg0Mzc1IC0yMC40NTcwMzEgMTUuNjU2MjUgLTIzLjA2MjUgQyAxOC40NzY1NjIgLTI1LjY2NDA2MiAyMi4wMDc4MTIgLTI2Ljk2ODc1IDI2LjI1IC0yNi45Njg3NSBDIDMwLjU1MDc4MSAtMjYuOTY4NzUgMzQuMTA5Mzc1IC0yNS42NjQwNjIgMzYuOTIxODc1IC0yMy4wNjI1IEMgMzkuNzM0Mzc1IC0yMC40NTcwMzEgNDEuMTQwNjI1IC0xNy4wNjY0MDYgNDEuMTQwNjI1IC0xMi44OTA2MjUgQyA0MS4xNDA2MjUgLTguNzczNDM4IDM5Ljc0MjE4OCAtNS40Mjk2ODggMzYuOTUzMTI1IC0yLjg1OTM3NSBDIDM0LjE3MTg3NSAtMC4yODUxNTYgMzAuNjAxNTYyIDEgMjYuMjUgMSBDIDIxLjk0NTMxMiAxIDE4LjM5ODQzOCAtMC4yODUxNTYgMTUuNjA5Mzc1IC0yLjg1OTM3NSBDIDEyLjgyODEyNSAtNS40Mjk2ODggMTEuNDM3NSAtOC43NzM0MzggMTEuNDM3NSAtMTIuODkwNjI1IFogTSAxMS40Mzc1IC0xMi44OTA2MjUgIi8+PC9nPjwvZz48L2c+PGcgZmlsbD0iI2Y0NWQyNSIgZmlsbC1vcGFjaXR5PSIxIj48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMjI5LjIzMjM1MywgODEzLjM3NzgzOCkiPjxnPjxwYXRoIGQ9Ik0gNjcuMDMxMjUgMCBDIDY1LjgxMjUgLTIuMzYzMjgxIDY0LjkyOTY4OCAtNS4zMDA3ODEgNjQuMzkwNjI1IC04LjgxMjUgQyA1OC4wMzUxNTYgLTEuNzI2NTYyIDQ5Ljc2OTUzMSAxLjgxMjUgMzkuNTkzNzUgMS44MTI1IEMgMjkuOTY4NzUgMS44MTI1IDIxLjk4ODI4MSAtMC45Njg3NSAxNS42NTYyNSAtNi41MzEyNSBDIDkuMzMyMDMxIC0xMi4xMDE1NjIgNi4xNzE4NzUgLTE5LjEyODkwNiA2LjE3MTg3NSAtMjcuNjA5Mzc1IEMgNi4xNzE4NzUgLTM4LjAyMzQzOCAxMC4wMzEyNSAtNDYuMDE1NjI1IDE3Ljc1IC01MS41NzgxMjUgQyAyNS40Njg3NSAtNTcuMTQ4NDM4IDM2LjYyNSAtNTkuOTY4NzUgNTEuMjE4NzUgLTYwLjAzMTI1IEwgNjMuMjk2ODc1IC02MC4wMzEyNSBMIDYzLjI5Njg3NSAtNjUuNjU2MjUgQyA2My4yOTY4NzUgLTcwLjE5NTMxMiA2Mi4xMjg5MDYgLTczLjgzMjAzMSA1OS43OTY4NzUgLTc2LjU2MjUgQyA1Ny40NzI2NTYgLTc5LjI4OTA2MiA1My43OTY4NzUgLTgwLjY1NjI1IDQ4Ljc2NTYyNSAtODAuNjU2MjUgQyA0NC4zNDc2NTYgLTgwLjY1NjI1IDQwLjg4MjgxMiAtNzkuNTkzNzUgMzguMzc1IC03Ny40Njg3NSBDIDM1Ljg2MzI4MSAtNzUuMzUxNTYyIDM0LjYwOTM3NSAtNzIuNDQ1MzEyIDM0LjYwOTM3NSAtNjguNzUgTCA4LjM1OTM3NSAtNjguNzUgQyA4LjM1OTM3NSAtNzQuNDM3NSAxMC4xMTMyODEgLTc5LjcwMzEyNSAxMy42MjUgLTg0LjU0Njg3NSBDIDE3LjEzMjgxMiAtODkuMzkwNjI1IDIyLjA5NzY1NiAtOTMuMTg3NSAyOC41MTU2MjUgLTk1LjkzNzUgQyAzNC45Mjk2ODggLTk4LjY5NTMxMiA0Mi4xNDA2MjUgLTEwMC4wNzgxMjUgNTAuMTQwNjI1IC0xMDAuMDc4MTI1IEMgNjIuMjQyMTg4IC0xMDAuMDc4MTI1IDcxLjg1MTU2MiAtOTcuMDM1MTU2IDc4Ljk2ODc1IC05MC45NTMxMjUgQyA4Ni4wODIwMzEgLTg0Ljg2NzE4OCA4OS42NDA2MjUgLTc2LjMxNjQwNiA4OS42NDA2MjUgLTY1LjI5Njg3NSBMIDg5LjY0MDYyNSAtMjIuNzAzMTI1IEMgODkuNzAzMTI1IC0xMy4zNzg5MDYgOTEuMDAzOTA2IC02LjMyODEyNSA5My41NDY4NzUgLTEuNTQ2ODc1IEwgOTMuNTQ2ODc1IDAgWiBNIDQ1LjMxMjUgLTE4LjI1IEMgNDkuMTg3NSAtMTguMjUgNTIuNzU3ODEyIC0xOS4xMTMyODEgNTYuMDMxMjUgLTIwLjg0Mzc1IEMgNTkuMzAwNzgxIC0yMi41NzAzMTIgNjEuNzIyNjU2IC0yNC44OTA2MjUgNjMuMjk2ODc1IC0yNy43OTY4NzUgTCA2My4yOTY4NzUgLTQ0LjY4NzUgTCA1My41IC00NC42ODc1IEMgNDAuMzUxNTYyIC00NC42ODc1IDMzLjM1OTM3NSAtNDAuMTQ0NTMxIDMyLjUxNTYyNSAtMzEuMDYyNSBMIDMyLjQyMTg3NSAtMjkuNTE1NjI1IEMgMzIuNDIxODc1IC0yNi4yNDIxODggMzMuNTcwMzEyIC0yMy41NDY4NzUgMzUuODc1IC0yMS40MjE4NzUgQyAzOC4xNzU3ODEgLTE5LjMwNDY4OCA0MS4zMjAzMTIgLTE4LjI1IDQ1LjMxMjUgLTE4LjI1IFogTSA0NS4zMTI1IC0xOC4yNSAiLz48L2c+PC9nPjwvZz48ZyBmaWxsPSIjZjQ1ZDI1IiBmaWxsLW9wYWNpdHk9IjEiPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDEzMjguOTQ2NzY1LCA4MTMuMzc3ODM4KSI+PGc+PHBhdGggZD0iTSAzNy43ODEyNSAwIEwgMTEuNDM3NSAwIEwgMTEuNDM3NSAtOTguMjY1NjI1IEwgMzcuNzgxMjUgLTk4LjI2NTYyNSBaIE0gOS45MDYyNSAtMTIzLjcwMzEyNSBDIDkuOTA2MjUgLTEyNy42Mjg5MDYgMTEuMjE4NzUgLTEzMC44NjMyODEgMTMuODQzNzUgLTEzMy40MDYyNSBDIDE2LjQ3NjU2MiAtMTM1Ljk1NzAzMSAyMC4wNjY0MDYgLTEzNy4yMzQzNzUgMjQuNjA5Mzc1IC0xMzcuMjM0Mzc1IEMgMjkuMDg1OTM4IC0xMzcuMjM0Mzc1IDMyLjY2MDE1NiAtMTM1Ljk1NzAzMSAzNS4zMjgxMjUgLTEzMy40MDYyNSBDIDM3Ljk5MjE4OCAtMTMwLjg2MzI4MSAzOS4zMjgxMjUgLTEyNy42Mjg5MDYgMzkuMzI4MTI1IC0xMjMuNzAzMTI1IEMgMzkuMzI4MTI1IC0xMTkuNzAzMTI1IDM3Ljk3NjU2MiAtMTE2LjQyOTY4OCAzNS4yODEyNSAtMTEzLjg5MDYyNSBDIDMyLjU5Mzc1IC0xMTEuMzQ3NjU2IDI5LjAzNTE1NiAtMTEwLjA3ODEyNSAyNC42MDkzNzUgLTExMC4wNzgxMjUgQyAyMC4xOTE0MDYgLTExMC4wNzgxMjUgMTYuNjMyODEyIC0xMTEuMzQ3NjU2IDEzLjkzNzUgLTExMy44OTA2MjUgQyAxMS4yNSAtMTE2LjQyOTY4OCA5LjkwNjI1IC0xMTkuNzAzMTI1IDkuOTA2MjUgLTEyMy43MDMxMjUgWiBNIDkuOTA2MjUgLTEyMy43MDMxMjUgIi8+PC9nPjwvZz48L2c+PC9zdmc+" preserveAspectRatio="xMidYMid meet"/>

  <!-- Player name -->
  <text x="540" y="160" fill="#ffffff" font-size="48" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" letter-spacing="-0.5">${esc(firstName)}</text>
  <text x="540" y="200" fill="#94A3B8" font-size="22" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Padel Rating Journey · ${esc(systemName)}</text>

  <!-- Stats boxes -->
  <rect x="80" y="240" width="280" height="130" rx="16" fill="rgba(255,255,255,0.08)"/>
  <text x="220" y="310" fill="#ffffff" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${firstRating.toFixed(1)}</text>
  <text x="220" y="345" fill="#94A3B8" font-size="16" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Start</text>

  <rect x="400" y="240" width="280" height="130" rx="16" fill="rgba(255,255,255,0.08)"/>
  <text x="540" y="310" fill="#ffffff" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${latestRating.toFixed(1)}</text>
  <text x="540" y="345" fill="#94A3B8" font-size="16" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Nu</text>

  <rect x="720" y="240" width="280" height="130" rx="16" fill="rgba(249,115,22,0.12)"/>
  <text x="860" y="310" fill="#F97316" font-size="52" font-weight="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">${bestRating.toFixed(1)}</text>
  <text x="860" y="345" fill="#F97316" font-size="16" font-weight="500" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">Best</text>

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
