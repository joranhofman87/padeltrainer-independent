import { forwardRef } from 'react';
import { format, differenceInMonths } from 'date-fns';
import logoLight from '@/assets/logo-light.svg';

interface RatingHistoryEntry {
  rating: number;
  scraped_at: string;
}

interface RatingShareCardProps {
  playerName: string;
  history: RatingHistoryEntry[];
  ratingSystem: string;
  systemName: string;
  lowerIsBetter: boolean;
}

function getCelebrationText(improvement: number, isAtBest: boolean): { emoji: string; text: string } {
  if (isAtBest && improvement > 0) return { emoji: '🏆', text: 'All-time best rating!' };
  if (improvement >= 3) return { emoji: '🚀', text: `Ongelofelijk! ${improvement.toFixed(1)} punten verbeterd` };
  if (improvement >= 1) return { emoji: '📈', text: `Stijgende lijn! +${improvement.toFixed(1)} punten` };
  if (improvement > 0) return { emoji: '💪', text: 'Stap voor stap beter' };
  return { emoji: '📊', text: `${Math.abs(improvement).toFixed(1)} punten verschil sinds de start` };
}

function getMilestoneBadges(improvement: number, historyMonths: number, isAtBest: boolean): string[] {
  const badges: string[] = [];
  if (improvement >= 3) badges.push('🔥 3+ punten verbeterd');
  if (historyMonths >= 12) badges.push('📅 1+ jaar actief');
  if (isAtBest && improvement > 0) badges.push('🏆 All-time high');
  return badges;
}

export const RatingShareCard = forwardRef<HTMLDivElement, RatingShareCardProps>(
  ({ playerName, history, ratingSystem, systemName, lowerIsBetter }, ref) => {
    if (history.length === 0) return null;

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

    const celebration = getCelebrationText(improvement, isAtBest);
    const badges = getMilestoneBadges(improvement, months, isAtBest);

    const firstName = playerName?.split(' ')[0] || 'Speler';
    const startLabel = format(firstDate, "MMM ''yy").toLowerCase();

    // Pure SVG chart points
    const chartW = 920, chartH = 300, pad = 24;
    const ratings = history.map(e => e.rating);
    const minR = Math.min(...ratings), maxR = Math.max(...ratings);
    const range = Math.max(maxR - minR, 1);
    const svgPoints = history.map((e, i) => {
      const x = pad + (i * (chartW - pad * 2)) / Math.max(history.length - 1, 1);
      const t = (e.rating - minR) / range;
      const y = lowerIsBetter ? pad + t * (chartH - pad * 2) : chartH - pad - t * (chartH - pad * 2);
      return `${x},${y}`;
    }).join(' ');
    const areaPoints = `${pad},${chartH - pad} ${svgPoints} ${chartW - pad},${chartH - pad}`;
    const firstDateLabel = format(firstDate, "MMM ''yy");
    const lastDateLabel = format(lastDate, "MMM ''yy");

    return (
      <div
        ref={ref}
        style={{
          width: 1080,
          height: 1350,
          background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 100%)',
          borderRadius: 24,
          padding: '60px 60px 50px',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#ffffff',
          position: 'absolute',
          left: -9999,
          top: -9999,
          overflow: 'hidden',
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 50 }}>
          <img src={logoLight} alt="PadelTrainer.ai" style={{ height: 40, objectFit: 'contain' }} />
        </div>

        {/* Player name + subtitle */}
        <div style={{ textAlign: 'center', marginBottom: 50 }}>
          <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 8 }}>
            {firstName}
          </div>
          <div style={{ fontSize: 22, color: '#94A3B8', fontWeight: 500 }}>
            Padel Rating Journey · {systemName}
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 30, marginBottom: 40 }}>
          <div style={{
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 16,
            padding: '24px 40px',
            textAlign: 'center',
            minWidth: 180,
          }}>
            <div style={{ fontSize: 56, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {firstRating.toFixed(1)}
            </div>
            <div style={{ fontSize: 16, color: '#94A3B8', fontWeight: 500, marginTop: 4 }}>Start</div>
          </div>
          <div style={{
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 16,
            padding: '24px 40px',
            textAlign: 'center',
            minWidth: 180,
          }}>
            <div style={{ fontSize: 56, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
              {latestRating.toFixed(1)}
            </div>
            <div style={{ fontSize: 16, color: '#94A3B8', fontWeight: 500, marginTop: 4 }}>Nu</div>
          </div>
        </div>

        {/* Improvement badge */}
        {improvement !== 0 && (
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <span style={{
              display: 'inline-block',
              background: improvement > 0
                ? 'rgba(34, 197, 94, 0.15)'
                : 'rgba(239, 68, 68, 0.15)',
              color: improvement > 0 ? '#22C55E' : '#EF4444',
              fontSize: 28,
              fontWeight: 700,
              padding: '12px 32px',
              borderRadius: 50,
              border: `1px solid ${improvement > 0 ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            }}>
              {celebration.emoji} {celebration.text}
            </span>
          </div>
        )}

        {/* Chart — pure SVG for reliable image capture */}
        <div style={{
          flex: 1,
          background: 'rgba(255,255,255,0.04)',
          borderRadius: 16,
          padding: '30px 20px 20px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          marginBottom: 30,
        }}>
          <svg viewBox={`0 0 ${chartW} ${chartH}`} width="100%" height={360} style={{ overflow: 'visible' }}>
            <defs>
              <linearGradient id="shareGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F97316" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#F97316" stopOpacity={0} />
              </linearGradient>
            </defs>
            <polygon points={areaPoints} fill="url(#shareGradient)" />
            <polyline points={svgPoints} fill="none" stroke="#F97316" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
            {/* X-axis labels */}
            <text x={pad} y={chartH - 2} fill="#475569" fontSize={13} textAnchor="start" fontFamily="system-ui, sans-serif">{firstDateLabel}</text>
            <text x={chartW - pad} y={chartH - 2} fill="#475569" fontSize={13} textAnchor="end" fontFamily="system-ui, sans-serif">{lastDateLabel}</text>
            {/* Y-axis labels */}
            <text x={pad - 4} y={lowerIsBetter ? pad + 4 : chartH - pad + 4} fill="#475569" fontSize={13} textAnchor="end" fontFamily="system-ui, sans-serif">{minR.toFixed(1)}</text>
            <text x={pad - 4} y={lowerIsBetter ? chartH - pad + 4 : pad + 4} fill="#475569" fontSize={13} textAnchor="end" fontFamily="system-ui, sans-serif">{maxR.toFixed(1)}</text>
          </svg>
        </div>

        {/* Milestone badges */}
        {badges.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
            {badges.map((badge, i) => (
              <span key={i} style={{
                background: 'rgba(249, 115, 22, 0.12)',
                color: '#F97316',
                fontSize: 16,
                fontWeight: 600,
                padding: '8px 20px',
                borderRadius: 50,
                border: '1px solid rgba(249, 115, 22, 0.25)',
              }}>
                {badge}
              </span>
            ))}
          </div>
        )}

        {/* Time stat */}
        <div style={{ textAlign: 'center', color: '#64748B', fontSize: 16, marginBottom: 30 }}>
          Sinds {startLabel} actief · {months} maanden progressie
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.08)',
          paddingTop: 24,
          textAlign: 'center',
          color: '#64748B',
          fontSize: 18,
        }}>
          Track jouw rating op <span style={{ color: '#F97316', fontWeight: 600 }}>padeltrainer.ai</span>
        </div>
      </div>
    );
  }
);

RatingShareCard.displayName = 'RatingShareCard';
