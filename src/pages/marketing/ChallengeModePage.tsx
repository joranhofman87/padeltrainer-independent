import { useState, useCallback, useMemo } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { MARKETING_DOMAIN } from '@/lib/domains';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import ChallengeCard from '@/components/challengemode/ChallengeCard';
import SuggestChallengeForm from '@/components/challengemode/SuggestChallengeForm';
import { challenges, type Challenge } from '@/lib/challengeModeData';
import { buildChallengeShareSvg } from '@/components/challengemode/ChallengeShareCard';
import { ChevronDown, Download, Copy, Share2 } from 'lucide-react';
import { toast } from 'sonner';

type Mode = 'practice' | 'game';
type Difficulty = Challenge['difficulty'];

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'chaos'];

export default function ChallengeModePage() {
  const { t } = useTranslation('marketing');
  const { lang = 'en' } = useParams<{ lang: string }>();
  const [searchParams] = useSearchParams();

  const webAppSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: t('challengeMode.title', 'Challenge Mode'),
    description: t('challengeMode.seo.description', 'Random padel challenges and match modifiers.'),
    applicationCategory: 'GameApplication',
    operatingSystem: 'Web',
    url: `${MARKETING_DOMAIN}/${lang}/playground/challenge-mode`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  };
  const breadcrumb = buildBreadcrumbList([
    { name: t('nav.home', 'Home'), url: `${MARKETING_DOMAIN}/${lang}` },
    { name: t('playground.title', 'Padel Playground'), url: `${MARKETING_DOMAIN}/${lang}/playground` },
    { name: t('challengeMode.title', 'Challenge Mode') },
  ]);

  const deepLinkedId = searchParams.get('c');
  const deepLinkedChallenge = deepLinkedId ? challenges.find(c => c.id === Number(deepLinkedId)) : null;

  const [mode, setMode] = useState<Mode | null>(deepLinkedChallenge ? (deepLinkedChallenge.mode === 'both' ? 'game' : deepLinkedChallenge.mode as Mode) : null);
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [current, setCurrent] = useState<Challenge | null>(deepLinkedChallenge || null);
  const [isFlipping, setIsFlipping] = useState(false);
  const [howToPlayOpen, setHowToPlayOpen] = useState(false);

  const filteredChallenges = useMemo(() => {
    if (!mode) return [];
    return challenges.filter(c => {
      const modeMatch = c.mode === mode || c.mode === 'both';
      const diffMatch = !difficulty || c.difficulty === difficulty;
      return modeMatch && diffMatch;
    });
  }, [mode, difficulty]);

  const getRandomChallenge = useCallback(() => {
    if (filteredChallenges.length === 0) return;
    let next: Challenge;
    do {
      next = filteredChallenges[Math.floor(Math.random() * filteredChallenges.length)];
    } while (filteredChallenges.length > 1 && next.id === current?.id);

    setIsFlipping(true);
    setTimeout(() => {
      setCurrent(next);
      setIsFlipping(false);
    }, 250);
  }, [filteredChallenges, current]);

  const handleCopyLink = () => {
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?c=${current.id}`;
    navigator.clipboard.writeText(url);
    toast.success(t('challengeMode.linkCopied', 'Link copied!'));
  };

  const handleDownload = async () => {
    if (!current) return;
    const svg = buildChallengeShareSvg(current);
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      const link = document.createElement('a');
      link.download = `padel-challenge-${current.id}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast.success(t('challengeMode.downloadSuccess', 'Image downloaded!'));
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };

  const handleWhatsApp = () => {
    if (!current) return;
    const url = `${window.location.origin}${window.location.pathname}?c=${current.id}`;
    const text = `Try this padel challenge: ${current.title}. Can you handle it? 🎲 ${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  // Mode selection screen
  if (!mode) {
    return (
      <MarketingLayout>
        <SEO
          title={t('challengeMode.seo.title', 'Padel Challenge Mode — Training Drills & Match Modifiers')}
          description={t('challengeMode.seo.description', 'Level up your padel game with random challenges. Practice drills to build skills or match modifiers to make games more fun.')}
          url={`/${lang}/playground/challenge-mode`}
          structuredData={[breadcrumb, webAppSchema]}
        />
        <div className="container mx-auto px-4 py-16 md:py-24">
          <div className="text-center mb-12">
            <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-4">
              🎲 {t('challengeMode.title', 'Challenge Mode')}
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              {t('challengeMode.subtitle', 'Random handicaps and training constraints. Pick your mode and spin.')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto">
            <button
              onClick={() => setMode('practice')}
              aria-label={t('challengeMode.selectPractice', 'Practice')}
              className="group rounded-2xl border bg-card p-8 hover:shadow-lg transition-all duration-200 hover:-translate-y-1 text-left"
            >
              <span className="text-5xl block mb-4">🎯</span>
              <h2 className="text-2xl font-bold text-foreground mb-2">
                {t('challengeMode.modePractice', 'Practice')}
              </h2>
              <p className="text-sm text-muted-foreground mb-1 font-medium">
                {t('challengeMode.practiceSubtitle', 'Drills and skill challenges')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('challengeMode.practiceDesc', 'Constraints that develop specific skills. Not about winning, but about improving.')}
              </p>
            </button>

            <button
              onClick={() => setMode('game')}
              aria-label={t('challengeMode.selectGame', 'Game')}
              className="group rounded-2xl border bg-card p-8 hover:shadow-lg transition-all duration-200 hover:-translate-y-1 text-left"
            >
              <span className="text-5xl block mb-4">🏆</span>
              <h2 className="text-2xl font-bold text-foreground mb-2">
                {t('challengeMode.modeGame', 'Game')}
              </h2>
              <p className="text-sm text-muted-foreground mb-1 font-medium">
                {t('challengeMode.gameSubtitle', 'Match modifiers')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('challengeMode.gameDesc', 'Fun twists for real matches. Fair and competitive. Both teams play with the same rules.')}
              </p>
            </button>
          </div>

          <p className="text-center text-sm text-muted-foreground mt-12">
            {t('challengeMode.challengeCount', '44 challenges and counting.')}{' '}
            <SuggestChallengeForm />
          </p>
        </div>
      </MarketingLayout>
    );
  }

  return (
    <MarketingLayout>
      <SEO
        title={t('challengeMode.seo.title', 'Padel Challenge Mode — Training Drills & Match Modifiers')}
        description={t('challengeMode.seo.description', 'Level up your padel game with random challenges. Practice drills to build skills or match modifiers to make games more fun.')}
        url={`/${lang}/playground/challenge-mode`}
        structuredData={[breadcrumb, webAppSchema]}
      />
      <div className="container mx-auto px-4 py-8 md:py-16 max-w-xl">
        {/* Mode toggle */}
        <div className="flex justify-center gap-2 mb-8">
          <button
            onClick={() => { setMode('practice'); setCurrent(null); }}
            className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${
              mode === 'practice'
                ? 'bg-blue-500/20 text-blue-400'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            🎯 {t('challengeMode.modePractice', 'Practice')}
          </button>
          <button
            onClick={() => { setMode('game'); setCurrent(null); }}
            className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${
              mode === 'game'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            🏆 {t('challengeMode.modeGame', 'Game')}
          </button>
        </div>

        {/* Challenge card area */}
        <div className="min-h-[440px] flex items-center justify-center mb-6">
          {current ? (
            <ChallengeCard challenge={current} isFlipping={isFlipping} />
          ) : (
            <div className="text-center text-muted-foreground">
              <p className="text-lg">{t('challengeMode.tapToStart', 'Tap below to get your first challenge')}</p>
            </div>
          )}
        </div>

        {/* Next Challenge button */}
        <Button
          onClick={getRandomChallenge}
          className="w-full h-14 text-lg font-bold rounded-xl"
          style={{ backgroundColor: '#f45d25' }}
          disabled={filteredChallenges.length === 0}
        >
          {current
            ? t('challengeMode.nextChallenge', 'Next Challenge 🎲')
            : t('challengeMode.getChallenge', 'Get Challenge 🎲')}
        </Button>

        {/* Difficulty filter chips */}
        <div className="flex justify-center gap-2 mt-4 flex-wrap">
          <button
            onClick={() => setDifficulty(null)}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              !difficulty ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
            }`}
          >
            {t('challengeMode.allDifficulties', 'All')}
          </button>
          {DIFFICULTIES.map(d => (
            <button
              key={d}
              onClick={() => setDifficulty(difficulty === d ? null : d)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                difficulty === d ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
              }`}
            >
              {t(`challengeMode.difficulty.${d}`, d.charAt(0).toUpperCase() + d.slice(1))}
            </button>
          ))}
        </div>

        {/* Share buttons */}
        {current && (
          <div className="flex justify-center gap-3 mt-6">
            <Button variant="outline" size="sm" onClick={handleCopyLink}>
              <Copy className="h-4 w-4 mr-1" /> {t('challengeMode.copyLink', 'Copy Link')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="h-4 w-4 mr-1" /> {t('challengeMode.download', 'Download')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleWhatsApp}>
              <Share2 className="h-4 w-4 mr-1" /> WhatsApp
            </Button>
          </div>
        )}

        {/* How to Play */}
        <div className="mt-10">
          <Collapsible open={howToPlayOpen} onOpenChange={setHowToPlayOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full justify-center">
              <ChevronDown className={`h-4 w-4 transition-transform ${howToPlayOpen ? 'rotate-180' : ''}`} />
              {t('challengeMode.howToPlay', 'How to Play')}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4 space-y-4 text-sm text-muted-foreground">
              <div>
                <h3 className="font-semibold text-foreground mb-1">{t('challengeMode.modePractice', 'Practice')}</h3>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>{t('challengeMode.howTo.p1', 'Pick "Practice" mode')}</li>
                  <li>{t('challengeMode.howTo.p2', 'Choose your difficulty level')}</li>
                  <li>{t('challengeMode.howTo.p3', 'Tap "Next Challenge" to get a random constraint')}</li>
                  <li>{t('challengeMode.howTo.p4', 'Play for the suggested duration (usually 10-15 minutes)')}</li>
                  <li>{t('challengeMode.howTo.p5', 'Spin again for the next drill')}</li>
                </ol>
              </div>
              <div>
                <h3 className="font-semibold text-foreground mb-1">{t('challengeMode.modeGame', 'Game')}</h3>
                <ol className="list-decimal pl-5 space-y-1">
                  <li>{t('challengeMode.howTo.g1', 'Pick "Game" mode')}</li>
                  <li>{t('challengeMode.howTo.g2', 'Choose your difficulty level')}</li>
                  <li>{t('challengeMode.howTo.g3', 'Tap "Next Challenge" to get a match modifier')}</li>
                  <li>{t('challengeMode.howTo.g4', 'Both teams play with the same constraint')}</li>
                  <li>{t('challengeMode.howTo.g5', 'Play a full set, then spin again')}</li>
                </ol>
              </div>
              <div>
                <h3 className="font-semibold text-foreground mb-1">{t('challengeMode.houseRules', 'House Rules')}</h3>
                <ul className="list-disc pl-5 space-y-1">
                  <li>{t('challengeMode.howTo.r1', 'Both teams always play with the same constraint')}</li>
                  <li>{t('challengeMode.howTo.r2', 'If you forget the constraint mid-point, the point stands but your partner can roast you')}</li>
                  <li>{t('challengeMode.howTo.r3', 'Chaos mode is optional. Friendships may be tested.')}</li>
                </ul>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* Suggest + counter */}
        <div className="text-center mt-8 text-sm text-muted-foreground">
          <p>{t('challengeMode.challengeCount', '44 challenges and counting.')}{' '}<SuggestChallengeForm /></p>
        </div>
      </div>
    </MarketingLayout>
  );
}
