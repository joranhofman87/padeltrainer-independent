import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ExternalLink, BookOpen, RotateCcw, Share2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { RacketResult, QuizAnswers } from '@/hooks/useRacketFinderQuery';
import { trackEvent } from '@/lib/tracking';
import { useState } from 'react';

const BADGES = [
  { key: 'topPick', emoji: '🏆' },
  { key: 'alternative', emoji: '⚡' },
  { key: 'greatValue', emoji: '💎' },
  { key: 'alsoConsider', emoji: '👀' },
  { key: 'wildcard', emoji: '🎯' },
] as const;

interface QuizResultsProps {
  rackets: RacketResult[];
  isLoading: boolean;
  answers: QuizAnswers;
  onRetake: () => void;
}

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

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="w-full"
    >
      <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-2 text-balance">
        {t('quiz.results.title', 'Your Perfect Racket Match')}
      </h2>
      <p className="text-muted-foreground text-center mb-8">
        {rackets.length > 0
          ? `${rackets.length} ${rackets.length === 1 ? 'racket' : 'rackets'} matched your profile`
          : t('quiz.results.noResults', 'No exact matches found. Try adjusting your preferences.')}
      </p>

      <div className="space-y-5 max-w-lg mx-auto">
        {rackets.map((racket, i) => {
          const badge = BADGES[i];
          return (
            <motion.div
              key={racket._id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.1, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-2xl border border-border bg-card p-5 sm:p-6 shadow-sm hover:shadow-md transition-shadow duration-200"
            >
              {badge && (
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary mb-3">
                  <span>{badge.emoji}</span>
                  {t(`quiz.results.${badge.key}`, badge.key)}
                </span>
              )}
              <h3 className="text-lg sm:text-xl font-bold text-foreground mb-1">{racket.name}</h3>
              <p className="text-sm text-muted-foreground mb-3">
                {racket.shape && <span className="capitalize">{racket.shape}</span>}
                {racket.playingStyle && <> · <span className="capitalize">{racket.playingStyle}</span></>}
                {racket.priceRange && <> · {racket.priceRange}</>}
              </p>
              {racket.shortDescription && (
                <p className="text-sm text-muted-foreground mb-4 italic">"{racket.shortDescription}"</p>
              )}
              {racket.specs && (
                <p className="text-xs text-muted-foreground font-mono mb-4">{racket.specs}</p>
              )}

              <div className="flex flex-wrap gap-2">
                {racket.affiliateUrl && (
                  <Button
                    size="sm"
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
                  asChild
                  onClick={() => trackEvent('quiz_result_click', { racket_name: racket.name, action: 'read_review' })}
                >
                  <a href={`/${lang}/blog/best-padel-rackets-2026`}>
                    {t('quiz.results.readReview', 'Read Review')} <BookOpen className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Share */}
      <div className="mt-8 text-center">
        <p className="text-sm font-medium text-muted-foreground mb-3">{shareText}</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => handleShare('whatsapp')}>
            WhatsApp
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleShare('twitter')}>
            𝕏
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleShare('copy')}>
            {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
            {copied ? 'Copied!' : 'Link'}
          </Button>
        </div>
      </div>

      {/* Retake & catalogue */}
      <div className="mt-8 text-center space-y-3">
        <Button
          variant="ghost"
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
