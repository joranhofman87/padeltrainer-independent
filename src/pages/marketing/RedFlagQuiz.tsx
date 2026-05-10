import { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { buildBreadcrumbList } from '@/lib/structuredData';
import { MARKETING_DOMAIN } from '@/lib/domains';
import { useTranslation } from 'react-i18next';
import { AnimatePresence } from 'framer-motion';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Button } from '@/components/ui/button';
import { RedFlagQuizQuestion } from '@/components/redflagquiz/RedFlagQuizQuestion';
import { RedFlagQuizResult } from '@/components/redflagquiz/RedFlagQuizResult';
import { questions, profiles, calculateResult, type ProfileId, type QuizProfile } from '@/lib/redFlagQuizData';

type Phase = 'intro' | 'quiz' | 'result';

export default function RedFlagQuiz() {
  const { t } = useTranslation('marketing');
  const [searchParams] = useSearchParams();
  const isChallenge = searchParams.get('ref') === 'challenge';

  const [phase, setPhase] = useState<Phase>('intro');
  const [currentQ, setCurrentQ] = useState(0);
  const [scores, setScores] = useState<Record<ProfileId, number>>({} as Record<ProfileId, number>);
  const [result, setResult] = useState<QuizProfile | null>(null);

  const startQuiz = () => {
    setScores({} as Record<ProfileId, number>);
    setCurrentQ(0);
    setResult(null);
    setPhase('quiz');
  };

  const handleAnswer = useCallback((optionIndex: number) => {
    const question = questions[currentQ];
    const profile = question.options[optionIndex].profile;
    const newScores = { ...scores, [profile]: (scores[profile] || 0) + 1 };
    setScores(newScores);

    if (currentQ + 1 < questions.length) {
      setCurrentQ(currentQ + 1);
    } else {
      const resultProfile = calculateResult(newScores);
      setResult(resultProfile);
      setPhase('result');
    }
  }, [currentQ, scores]);

  const retake = () => {
    startQuiz();
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('redFlagQuiz.seo.title', "What's Your Padel Red Flag? | Fun Quiz — PadelTrainer.ai")}
        description={t('redFlagQuiz.seo.description', 'Every padel player has a red flag. Take this 2-minute quiz to find out yours — and challenge your padel partner to take it too.')}
      />

      <div className="min-h-[70vh] flex items-center justify-center py-12">
        {phase === 'intro' && (
          <div className="text-center max-w-lg mx-auto px-4">
            <div className="text-7xl mb-6">🚩</div>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              {t('redFlagQuiz.intro.title', "What's Your Padel Red Flag?")}
            </h1>
            {isChallenge && (
              <p className="text-primary font-medium mb-2">
                {t('redFlagQuiz.intro.challenge', 'Your friend thinks you need to take this quiz 😏')}
              </p>
            )}
            <p className="text-muted-foreground mb-8">
              {t('redFlagQuiz.intro.subtitle', '10 questions. 2 minutes. No judgment (okay, maybe a little). Find out what kind of padel partner you really are.')}
            </p>
            <Button size="lg" onClick={startQuiz} className="text-lg px-8">
              {t('redFlagQuiz.intro.start', "Let's Go 🎾")}
            </Button>
          </div>
        )}

        {phase === 'quiz' && (
          <AnimatePresence mode="wait">
            <RedFlagQuizQuestion
              key={currentQ}
              question={questions[currentQ]}
              questionIndex={currentQ}
              total={questions.length}
              onAnswer={handleAnswer}
            />
          </AnimatePresence>
        )}

        {phase === 'result' && result && (
          <RedFlagQuizResult profile={result} onRetake={retake} />
        )}
      </div>
    </MarketingLayout>
  );
}
