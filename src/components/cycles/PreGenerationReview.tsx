import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Lightbulb,
  AlertTriangle,
  Link2,
  X,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getSuggestedLinks,
  getLinkedIdsForRequest,
  getDismissedSuggestions,
  dismissSuggestion,
  getUnmatchedMentions,
  getDismissedUnmatched,
  dismissUnmatchedMention,
} from '@/lib/suggestLinks';
import { linkPlayers, type IntakeRequestWithProposal, type PlayerLink } from '@/lib/cycles';

interface PreGenerationReviewProps {
  requests: IntakeRequestWithProposal[];
  playerLinks: PlayerLink[];
  onLinkChanged: () => void;
  onPlayerClick?: (requestId: string) => void;
  onContinue: () => void;
  hasPendingLinks: boolean;
}

interface SuggestionItem {
  requestId: string;
  requestName: string;
  suggestedId: string;
  suggestedName: string;
}

interface UnmatchedItem {
  requestId: string;
  requestName: string;
  mentionedName: string;
}

export default function PreGenerationReview({
  requests,
  playerLinks,
  onLinkChanged,
  onPlayerClick,
  onContinue,
  hasPendingLinks,
}: PreGenerationReviewProps) {
  const { t } = useTranslation('cycles');
  const [dismissCounter, setDismissCounter] = useState(0);
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());

  const { suggestions, unmatchedMentions } = useMemo(() => {
    const dismissed = getDismissedSuggestions();
    const dismissedUnmatched = getDismissedUnmatched();

    const allSuggestions: SuggestionItem[] = [];
    const allUnmatched: UnmatchedItem[] = [];
    const seenPairs = new Set<string>();

    for (const req of requests) {
      const linkedIds = new Set(getLinkedIdsForRequest(req.id, playerLinks));
      const matches = getSuggestedLinks(req, requests, linkedIds, dismissed);

      for (const match of matches) {
        const pairKey = [req.id, match.id].sort().join('::');
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          allSuggestions.push({
            requestId: req.id,
            requestName: req.full_name,
            suggestedId: match.id,
            suggestedName: match.full_name,
          });
        }
      }

      const unmatched = getUnmatchedMentions(req, requests, dismissedUnmatched);
      for (const name of unmatched) {
        allUnmatched.push({
          requestId: req.id,
          requestName: req.full_name,
          mentionedName: name,
        });
      }
    }

    return { suggestions: allSuggestions, unmatchedMentions: allUnmatched };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, playerLinks, dismissCounter]);

  const totalActions = suggestions.length;

  const handleLink = useCallback(async (item: SuggestionItem) => {
    const key = `${item.requestId}::${item.suggestedId}`;
    setLinkingIds(prev => new Set(prev).add(key));
    try {
      await linkPlayers([item.requestId, item.suggestedId]);
      toast.success(t('suggestions.linked', { defaultValue: 'Players linked' }));
      onLinkChanged();
    } catch (error: any) {
      toast.error(error.message);
    } finally {
      setLinkingIds(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [onLinkChanged, t]);

  const handleDismissSuggestion = useCallback((item: SuggestionItem) => {
    dismissSuggestion(item.requestId, item.suggestedId);
    setDismissCounter(c => c + 1);
  }, []);

  const handleDismissUnmatched = useCallback((item: UnmatchedItem) => {
    dismissUnmatchedMention(item.requestId, item.mentionedName);
    setDismissCounter(c => c + 1);
  }, []);

  return (
    <div className="space-y-4">
      {/* Continue button — always visible at top */}
      <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
        <div className="text-sm text-muted-foreground">
          {hasPendingLinks
            ? t('preReview.resolveFirst', {
                defaultValue: 'Resolve all link suggestions before continuing',
              })
            : t('preReview.readyToContinue', {
                defaultValue: 'All links reviewed — ready to generate proposals',
              })}
        </div>
        <Button
          onClick={onContinue}
          disabled={hasPendingLinks}
          className={!hasPendingLinks ? 'bg-green-600 hover:bg-green-700 text-white' : ''}
        >
          {t('workflow.continueToGenerate', { defaultValue: 'Continue to Generate' })}
          <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
      </div>

      {/* All clear state */}
      {totalActions === 0 && (
        <Card className="border-green-500/20 bg-green-500/5">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-sm font-medium">
                {t('preReview.allClear', { defaultValue: 'All clear — no pending link actions' })}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Link suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
            <Lightbulb className="h-3.5 w-3.5" />
            {t('preReview.linkSuggestions', {
              defaultValue: '{{count}} link suggestion(s)',
              count: suggestions.length,
            })}
          </div>
          <div className="space-y-1.5">
            {suggestions.map((item) => {
              const key = `${item.requestId}::${item.suggestedId}`;
              const isLinking = linkingIds.has(key);
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 p-2 rounded-md border bg-card text-sm"
                >
                  <span className="truncate">
                    <button
                      type="button"
                      className="font-medium underline decoration-dotted hover:decoration-solid cursor-pointer hover:text-primary transition-colors"
                      onClick={() => onPlayerClick?.(item.requestId)}
                    >
                      {item.requestName}
                    </button>
                    <span className="text-muted-foreground mx-1">→</span>
                    <button
                      type="button"
                      className="font-medium underline decoration-dotted hover:decoration-solid cursor-pointer hover:text-primary transition-colors"
                      onClick={() => onPlayerClick?.(item.suggestedId)}
                    >
                      {item.suggestedName}
                    </button>
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => handleLink(item)}
                      disabled={isLinking}
                    >
                      <Link2 className="h-3 w-3 mr-1" />
                      {t('suggestions.link', { defaultValue: 'Link' })}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => handleDismissSuggestion(item)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Unmatched mentions — info only, always visible */}
      {unmatchedMentions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3 w-3" />
            {t('preReview.unmatchedInfo', {
              defaultValue: '{{count}} mentioned name(s) not found in registrations',
              count: unmatchedMentions.length,
            })}
          </div>
          <div className="space-y-1.5">
            {unmatchedMentions.map((item, idx) => (
              <div
                key={`${item.requestId}::${item.mentionedName}::${idx}`}
                className="flex items-center justify-between gap-2 p-2 rounded-md border border-muted bg-muted/30 text-sm text-muted-foreground"
              >
                <span className="truncate">
                  <button
                    type="button"
                    className="font-medium underline decoration-dotted hover:decoration-solid cursor-pointer hover:text-primary transition-colors"
                    onClick={() => onPlayerClick?.(item.requestId)}
                  >
                    {item.requestName}
                  </button>
                  <span className="mx-1">
                    {t('preReview.mentioned', { defaultValue: 'mentioned' })}
                  </span>
                  <span className="font-medium italic">{item.mentionedName}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 shrink-0"
                  onClick={() => handleDismissUnmatched(item)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
