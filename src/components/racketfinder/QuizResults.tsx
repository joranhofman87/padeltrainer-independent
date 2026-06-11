import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ExternalLink, BookOpen, RotateCcw, Copy, Check, Trophy, Zap, Gem, Eye, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { RacketImage } from '@/components/gear/RacketImage';
import type { RacketResult, QuizAnswers } from '@/hooks/useRacketFinderQuery';
import { trackEvent } from '@/lib/tracking';
import { useState } from 'react';

const BADGES = [
  { key: 'topPick', icon: Trophy, color: 'text-amber-600' },
  { key: 'alternative', icon: Zap, color: 'text-blue-600' },
  { key: 'greatValue', icon: Gem, color: 'text-emerald-600' },
  { key: 'alsoConsider', icon: Eye, color: 'text-violet-600' },
  { key: 'wildcard', icon: Target, color: 'text-rose-600' },
] as const;

interface QuizResultsProps {
  rackets: RacketResult[];
  isLoading: boolean;
  answers: QuizAnswers;
  onRetake: () => void;
}

const STYLE_LABELS: Record<string, string> = {
  control: 'Control',
  allround: 'Allround',
  power: 'Power',
};

const SHAPE_LABELS: Record<string, string> = {
  round: 'Round',
  teardrop: 'Teardrop',
  diamond: 'Diamond',
};

export default function QuizResults({ rackets, isLoading, answers, onRetake }: QuizResultsProps) {
  const { t } = useTranslation('marketing');
  const { lang = 'en' } = useParams<{ lang: string }>();
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-lg mx-auto">
        {[0, 1, 2].map(i => (
          <Skeleton key={i} className="h-56 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  const shareUrl = `${window.location.origin}/${lang}/racket-finder?level=${answers.level}&style=${answers.style}&budget=${answers.budget}&arm=${answers.armFriendly}&weight=${answers.weight}&shape=${answers.shape}`;
  const shareText = t('quiz.share', 'Share your result');

  function handleShare(platform: string) {
    trackEvent('quiz_shared', { platform });
    if (platform === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(shareUrl)}`, '_blank');
    } else if (platform === 'twitter') {
      window.open(`https://x.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent('Found my perfect padel racket!')}`, '_blank');
    } else if (platform === 'copy') {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // Build preference pills
  const prefPills = [
    { label: answers.level.charAt(0).toUpperCase() + answers.level.slice(1) },
    ...(answers.style !== 'control' || answers.level !== 'beginner' ? [{ label: STYLE_LABELS[answers.style] || answers.style }] : []),
    { label: `€${answers.budget.replace('-', '–').replace('999', '+')}` },
    ...(answers.shape && answers.shape !== 'any' ? [{ label: SHAPE_LABELS[answers.shape] || answers.shape }] : []),
    ...(answers.armFriendly ? [{ label: t('quiz.results.armFriendly', 'Arm-friendly') }] : []),
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="w-full"
    >
      <h2 className="text-3xl sm:text-4xl font-bold text-foreground text-center mb-3 text-balance leading-tight">
        {t('quiz.results.title', 'Your Perfect Racket Match')}
      </h2>
      <p className="text-muted-foreground text-center mb-6">
        {rackets.length > 0
          ? `${rackets.length} ${rackets.length === 1 ? 'racket' : 'rackets'} matched your profile`
          : t('quiz.results.noResults', 'No exact matches found. Try adjusting your preferences.')}
      </p>

      {/* Preference pills */}
      <div className="flex flex-wrap justify-center gap-2 mb-10">
        {prefPills.map((pill) => (
          <Badge key={pill.label} variant="secondary" className="text-xs font-medium px-3 py-1 rounded-full">
            {pill.label}
          </Badge>
        ))}
      </div>

      <div className="space-y-5 max-w-lg mx-auto">
        {rackets.map((racket, i) => {
          const badge = BADGES[i];
          const isTopPick = i === 0;
          const BadgeIcon = badge?.icon;

          return (
            <motion.div
              key={racket._id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.1, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`relative rounded-2xl border-2 bg-card overflow-hidden transition-shadow duration-200 hover:shadow-lg ${
                isTopPick
                  ? 'border-primary ring-1 ring-primary/20 shadow-md'
                  : 'border-border shadow-sm hover:shadow-md'
              }`}
            >
              {/* Top pick gradient accent */}
              {isTopPick && (
                <div className="h-1 bg-gradient-to-r from-primary via-primary/70 to-primary/40" />
              )}

              <div className="p-5 sm:p-6">
                {/* Badge */}
                {badge && BadgeIcon && (
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`flex items-center gap-1.5 text-sm font-semibold ${badge.color}`}>
                      <BadgeIcon className="h-4 w-4" />
                      {t(`quiz.results.${badge.key}`, badge.key)}
                    </div>
                    {isTopPick && (
                      <Badge className="text-[10px] px-2 py-0 bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">
                        Best Match
                      </Badge>
                    )}
                  </div>
                )}

                {/* Racket info */}
                <h3 className="text-xl font-bold text-foreground mb-2">{racket.name}</h3>

                {/* Spec pills */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {racket.shape && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground capitalize">
                      {racket.shape}
                    </span>
                  )}
                  {racket.playingStyle && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground capitalize">
                      {racket.playingStyle}
                    </span>
                  )}
                  {racket.priceRange && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                      {racket.priceRange}
                    </span>
                  )}
                </div>

                {racket.shortDescription && (
                  <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                    {racket.shortDescription}
                  </p>
                )}

                {racket.specs && (
                  <p className="text-xs text-muted-foreground/70 font-mono mb-4">{racket.specs}</p>
                )}

                <div className="flex flex-wrap gap-2">
                  {racket.affiliateUrl && (
                    <Button
                      size="sm"
                      className={isTopPick ? 'rounded-full' : 'rounded-full'}
                      onClick={() => {
                        trackEvent('quiz_result_click', { racket_name: racket.name, action: 'check_price' });
                        window.open(racket.affiliateUrl, '_blank');
                      }}
                    >
                      {t('quiz.results.checkPrice', 'Check Price')} <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    asChild
                    aria-label={t('quiz.results.readReview', 'Read Review')}
                    onClick={() => trackEvent('quiz_result_click', { racket_name: racket.name, action: 'read_review' })}
                  >
                    <a href={`/${lang}/blog/best-padel-rackets-2026`}>
                      {t('quiz.results.readReview', 'Read Review')} <BookOpen className="ml-1.5 h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Share */}
      <div className="mt-10 text-center">
        <p className="text-sm font-medium text-muted-foreground mb-3">{shareText}</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => handleShare('whatsapp')}>
            WhatsApp
          </Button>
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => handleShare('twitter')}>
            𝕏
          </Button>
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => handleShare('copy')}>
            {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
            {copied ? 'Copied!' : 'Link'}
          </Button>
        </div>
      </div>

      {/* Retake & catalogue */}
      <div className="mt-8 text-center space-y-3">
        <Button
          variant="ghost"
          className="rounded-full"
          onClick={() => {
            trackEvent('quiz_retake');
            onRetake();
          }}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('quiz.results.retake', 'Not quite right? Retake Quiz')}
        </Button>
        <div>
          <a
            href={`/${lang}/blog/best-padel-rackets-2026`}
            className="text-sm text-primary underline underline-offset-4 hover:text-primary/80 transition-colors"
          >
            {t('quiz.results.viewAll', 'View Full Racket Catalogue →')}
          </a>
        </div>
      </div>
    </motion.div>
  );
}
