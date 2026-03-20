import { useState, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import posthog from 'posthog-js';

import { SEO } from '@/components/SEO';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { LevelQuizQuestion } from '@/components/levelquiz/LevelQuizQuestion';
import { LevelQuizResults } from '@/components/levelquiz/LevelQuizResults';
import {
  getQuestions, calculateLevel, getDefaultCountry,
  getLevelInfo, QUIZ_COUNTRIES,
  type QuizCountry,
} from '@/lib/levelQuizData';
import { usePageTracking } from '@/hooks/usePageTracking';

type Phase = 'intro' | 'quiz' | 'results';

export default function PadelLevelTest() {
  usePageTracking();
  const { t } = useTranslation('marketing');
  const { lang } = useParams<{ lang: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentLang = lang ?? 'en';
  const questions = useMemo(() => getQuestions(currentLang), [currentLang]);

  // Check for shared result params
  const sharedResult = searchParams.get('result');
  const sharedCountry = searchParams.get('country');

  const [country, setCountry] = useState<QuizCountry>(
    () => ((sharedCountry && QUIZ_COUNTRIES.some(c => c.value === sharedCountry) ? sharedCountry : getDefaultCountry(currentLang)) as QuizCountry)
  );
  const [phase, setPhase] = useState<Phase>(sharedResult ? 'results' : 'intro');
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>(Array(questions.length).fill(null));
  const [direction, setDirection] = useState(1);

  const resultLevel = sharedResult ? parseFloat(sharedResult) : calculateLevel(
    answers.reduce<number>((sum, a, i) => sum + (a !== null ? questions[i].options[a].points : 0), 0)
  );

  const handleStart = () => {
    posthog.capture('level_quiz_started', { country });
    setPhase('quiz');
  };

  const handleSelect = useCallback((optionIndex: number) => {
    setAnswers(prev => {
      const next = [...prev];
      next[currentQ] = optionIndex;
      return next;
    });
    posthog.capture('level_quiz_answer', {
      question: currentQ + 1,
      answer: ['A', 'B', 'C', 'D'][optionIndex],
      points: questions[currentQ].options[optionIndex].points,
    });
  }, [currentQ, questions]);

  const goNext = () => {
    if (currentQ < questions.length - 1) {
      setDirection(1);
      setCurrentQ(q => q + 1);
    } else {
      // Calculate final
      const totalPoints = answers.reduce<number>(
        (sum, a, i) => sum + (a !== null ? questions[i].options[a].points : 0), 0
      );
      const level = calculateLevel(totalPoints);
      const info = getLevelInfo(level);

      posthog.capture('level_quiz_completed', {
        level,
        levelTitle: info.title,
        country,
        countryRating: '',
        totalPoints,
      });

      setSearchParams({ result: level.toString(), country }, { replace: true });
      setPhase('results');
    }
  };

  const goBack = () => {
    if (currentQ > 0) {
      setDirection(-1);
      setCurrentQ(q => q - 1);
    }
  };

  const handleRetake = () => {
    setAnswers(Array(questions.length).fill(null));
    setCurrentQ(0);
    setPhase('intro');
    setSearchParams({}, { replace: true });
  };

  const progressPercent = ((currentQ + 1) / questions.length) * 100;
  const canProceed = answers[currentQ] !== null;
  const isLastQuestion = currentQ === questions.length - 1;

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'Quiz',
    name: 'Padel Level Self-Assessment Test',
    description: '10-question quiz to assess your padel level on the international 1.0–7.0 scale',
    educationalLevel: 'All levels',
    about: { '@type': 'SportsEvent', sport: 'Padel' },
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('levelQuiz.title')}
        description={t('levelQuiz.subtitle')}
        url={`/tools/padel-level-test`}
        structuredData={structuredData}
      />

      <div className="container max-w-2xl mx-auto py-12 px-4 min-h-[60vh]">
        {/* ── INTRO ───────────────── */}
        {phase === 'intro' && (
          <motion.div
            initial={{ opacity: 0, y: 20, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="text-center space-y-6"
          >
            <h1 className="text-3xl md:text-4xl font-bold text-foreground text-wrap-balance">
              {t('levelQuiz.title')}
            </h1>
            <p className="text-lg text-muted-foreground max-w-lg mx-auto">
              {t('levelQuiz.subtitle')}
            </p>

            <div className="max-w-xs mx-auto space-y-2">
              <label className="text-sm text-muted-foreground">{t('levelQuiz.selectCountry')}</label>
              <Select value={country} onValueChange={(v) => setCountry(v as QuizCountry)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUIZ_COUNTRIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button size="lg" onClick={handleStart} className="mt-4">
              {t('levelQuiz.startQuiz')}
            </Button>
          </motion.div>
        )}

        {/* ── QUIZ ────────────────── */}
        {phase === 'quiz' && (
          <div className="space-y-6">
            <Progress value={progressPercent} className="h-2" />

            <AnimatePresence mode="wait" initial={false}>
              <LevelQuizQuestion
                key={currentQ}
                question={questions[currentQ]}
                questionIndex={currentQ}
                totalQuestions={questions.length}
                selectedOption={answers[currentQ]}
                onSelect={handleSelect}
                direction={direction}
              />
            </AnimatePresence>

            <div className="flex justify-between pt-4">
              <Button
                variant="ghost"
                onClick={goBack}
                disabled={currentQ === 0}
                className="gap-1"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('levelQuiz.back')}
              </Button>
              <Button
                onClick={goNext}
                disabled={!canProceed}
                className="gap-1"
              >
                {isLastQuestion ? t('levelQuiz.seeResults') : t('levelQuiz.next')}
                {!isLastQuestion && <ChevronRight className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        )}

        {/* ── RESULTS ─────────────── */}
        {phase === 'results' && (
          <LevelQuizResults
            level={resultLevel}
            country={country}
            onCountryChange={setCountry}
            onRetake={handleRetake}
          />
        )}
      </div>
    </MarketingLayout>
  );
}
