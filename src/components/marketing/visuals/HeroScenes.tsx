import * as React from 'react';
import {
  MockWindow,
  MiniCalendarGrid,
  MiniChecklist,
  MiniArticleCard,
  MiniBarChart,
  MiniCourtDiagram,
  MiniVideoFrame,
  MiniRacketSwatch,
  MiniMapPin,
  MiniQuizDots,
  MiniStarRating,
  MiniPhoneBooking,
} from './index';

/**
 * Pre-composed hero visual scenes for marketing pages.
 * Pass one of these into <MarketingHero visual={...} /> to mirror the homepage chrome.
 * All scenes use only design tokens — no hardcoded colors, no images.
 */

function Scene({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; right: React.ReactNode }[];
}) {
  return (
    <MockWindow title={title} className="ml-auto max-w-md w-full">
      <div className="space-y-4">
        {rows.map((row, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 rounded-lg border border-navy-900/5 bg-cream/40 px-4 py-3"
          >
            <div className="text-sm font-medium text-navy-800">{row.label}</div>
            <div className="shrink-0">{row.right}</div>
          </div>
        ))}
      </div>
    </MockWindow>
  );
}

export function HeroVisualSchedule() {
  return (
    <Scene
      title="Schedule"
      rows={[
        { label: 'This week', right: <MiniCalendarGrid /> },
        { label: 'Bookings', right: <MiniChecklist /> },
        { label: 'Reminders', right: <MiniPhoneBooking /> },
      ]}
    />
  );
}

export function HeroVisualPricing() {
  return (
    <Scene
      title="Plan analytics"
      rows={[
        { label: 'Monthly revenue', right: <MiniBarChart /> },
        { label: 'Active members', right: <MiniChecklist /> },
        { label: 'Trial conversion', right: <MiniStarRating filled={4} /> },
      ]}
    />
  );
}

export function HeroVisualAbout() {
  return (
    <Scene
      title="What we ship"
      rows={[
        { label: 'Built for coaches', right: <MiniChecklist /> },
        { label: 'Player tools', right: <MiniPhoneBooking /> },
        { label: 'Open ratings', right: <MiniStarRating filled={5} /> },
      ]}
    />
  );
}

export function HeroVisualCoaches() {
  return (
    <Scene
      title="Find a coach"
      rows={[
        { label: 'Near you', right: <MiniMapPin /> },
        { label: 'Verified', right: <MiniChecklist /> },
        { label: 'Reviews', right: <MiniStarRating filled={5} /> },
      ]}
    />
  );
}

export function HeroVisualLearn() {
  return (
    <Scene
      title="Learning hub"
      rows={[
        { label: 'Latest article', right: <MiniArticleCard /> },
        { label: 'Court tactics', right: <MiniCourtDiagram /> },
        { label: 'Video tips', right: <MiniVideoFrame /> },
      ]}
    />
  );
}

export function HeroVisualTopics() {
  return (
    <Scene
      title="Pillar topics"
      rows={[
        { label: 'Beginner basics', right: <MiniArticleCard /> },
        { label: 'Smashes', right: <MiniCourtDiagram /> },
        { label: 'Rackets', right: <MiniRacketSwatch /> },
      ]}
    />
  );
}

export function HeroVisualBlog() {
  return (
    <Scene
      title="Blog"
      rows={[
        { label: 'Featured', right: <MiniArticleCard /> },
        { label: 'Latest', right: <MiniArticleCard /> },
        { label: 'Top rated', right: <MiniStarRating filled={5} /> },
      ]}
    />
  );
}

export function HeroVisualPlayground() {
  return (
    <Scene
      title="Playground"
      rows={[
        { label: 'Quizzes', right: <MiniQuizDots /> },
        { label: 'Racket finder', right: <MiniRacketSwatch /> },
        { label: 'Court ratings', right: <MiniStarRating filled={4} /> },
      ]}
    />
  );
}

export function HeroVisualStrokes() {
  return (
    <Scene
      title="Strokes library"
      rows={[
        { label: 'Court positions', right: <MiniCourtDiagram /> },
        { label: 'Step by step', right: <MiniChecklist /> },
        { label: 'Watch it', right: <MiniVideoFrame /> },
      ]}
    />
  );
}

export function HeroVisualRules() {
  return (
    <Scene
      title="Padel rules"
      rows={[
        { label: 'Court layout', right: <MiniCourtDiagram /> },
        { label: 'Scoring', right: <MiniChecklist /> },
        { label: 'Edge cases', right: <MiniQuizDots /> },
      ]}
    />
  );
}

export function HeroVisualVideo() {
  return (
    <Scene
      title="Video tips"
      rows={[
        { label: 'New this week', right: <MiniVideoFrame /> },
        { label: 'Drills', right: <MiniCourtDiagram /> },
        { label: 'Coach picks', right: <MiniStarRating filled={5} /> },
      ]}
    />
  );
}

export function HeroVisualRackets() {
  return (
    <Scene
      title="Racket finder"
      rows={[
        { label: 'Match your level', right: <MiniRacketSwatch /> },
        { label: 'Compare specs', right: <MiniBarChart /> },
        { label: 'Player reviews', right: <MiniStarRating filled={4} /> },
      ]}
    />
  );
}

export function HeroVisualQuiz() {
  return (
    <Scene
      title="Quiz"
      rows={[
        { label: 'Progress', right: <MiniQuizDots /> },
        { label: 'Result', right: <MiniChecklist /> },
        { label: 'Share it', right: <MiniStarRating filled={4} /> },
      ]}
    />
  );
}

export function HeroVisualPartner() {
  return (
    <Scene
      title="Partner program"
      rows={[
        { label: 'Co-marketing', right: <MiniChecklist /> },
        { label: 'Revenue share', right: <MiniBarChart /> },
        { label: 'Network', right: <MiniMapPin /> },
      ]}
    />
  );
}
