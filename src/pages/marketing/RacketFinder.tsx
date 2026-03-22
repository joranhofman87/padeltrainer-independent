import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { motion } from 'framer-motion';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { SEO } from '@/components/SEO';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import QuizQuestion from '@/components/racketfinder/QuizQuestion';
import type { QuizOption } from '@/components/racketfinder/QuizQuestion';
import QuizResults from '@/components/racketfinder/QuizResults';
import { useRacketFinderQuery, type QuizAnswers } from '@/hooks/useRacketFinderQuery';
import { trackEvent } from '@/lib/tracking';

type Phase = 'intro' | 'quiz' | 'results';

interface StepDef {
  key: keyof QuizAnswers;
  questionKey: string;
  options: QuizOption[];
}

function useSteps(t: (k: string, d?: string) => string): StepDef[] {
  return useMemo(() => [
    {
      key: 'level',
      questionKey: 'quiz.q1',
      options: [
        { emoji: '🌱', label: t('quiz.a1.beginner', 'Just starting out'), value: 'beginner' },
        { emoji: '🎾', label: t('quiz.a1.intermediate', 'I play regularly (1-2x per week)'), value: 'intermediate' },
        { emoji: '🏆', label: t('quiz.a1.advanced', 'I compete in tournaments'), value: 'advanced' },
      ],
    },
    {
      key: 'style',
      questionKey: 'quiz.q2',
      options: [
        { emoji: '🛡️', label: t('quiz.a2.control', 'Defend and control the rally'), value: 'control' },
        { emoji: '⚖️', label: t('quiz.a2.allround', 'A mix of everything'), value: 'allround' },
        { emoji: '💥', label: t('quiz.a2.power', 'Attack and finish points with power'), value: 'power' },
      ],
    },
    {
      key: 'budget',
      questionKey: 'quiz.q3',
      options: [
        { emoji: '💰', label: t('quiz.a3.under100', 'Under €100'), value: '100' },
        { emoji: '💰', label: '€100 – €150', value: '150' },
        { emoji: '💰', label: '€150 – €200', value: '200' },
        { emoji: '💰', label: '€200+', value: '999' },
      ],
    },
    {
      key: 'armFriendly',
      questionKey: 'quiz.q4',
      options: [
        { emoji: '💪', label: t('quiz.a4.yes', 'Yes, I need something soft on my arm'), value: 'true' },
        { emoji: '✅', label: t('quiz.a4.no', 'No issues'), value: 'false' },
      ],
    },
    {
      key: 'weight',
      questionKey: 'quiz.q5',
      options: [
        { emoji: '🪶', label: t('quiz.a5.light', 'Light racket (easier to swing)'), value: 'light' },
        { emoji: '⚖️', label: t('quiz.a5.medium', 'Standard weight'), value: 'medium' },
        { emoji: '🏋️', label: t('quiz.a5.heavy', 'Heavier (more stability)'), value: 'heavy' },
        { emoji: '🤷', label: t('quiz.a5.any', 'No preference'), value: 'any' },
      ],
    },
    {
      key: 'shape',
      questionKey: 'quiz.q6',
      options: [
        { emoji: '⭕', label: t('quiz.a6.round', 'Round (maximum control)'), value: 'round' },
        { emoji: '💧', label: t('quiz.a6.teardrop', 'Teardrop (balance of control & power)'), value: 'teardrop' },
        { emoji: '💎', label: t('quiz.a6.diamond', 'Diamond (maximum power)'), value: 'diamond' },
        { emoji: '🤷', label: t('quiz.a6.any', 'Not sure — recommend for me'), value: 'any' },
      ],
    },
  ], [t]);
}

function parseAnswersFromParams(params: URLSearchParams): QuizAnswers | null {
  const level = params.get('level');
  const style = params.get('style');
  const budget = params.get('budget');
  if (!level || !style || !budget) return null;
  return {
    level: level as QuizAnswers['level'],
    style: style as QuizAnswers['style'],
    budget: budget,
    armFriendly: params.get('arm') === 'true',
    weight: (params.get('weight') || 'any') as QuizAnswers['weight'],
    shape: (params.get('shape') || 'any') as QuizAnswers['shape'],
  };
}

export default function RacketFinder() {
  const { t, i18n } = useTranslation('marketing');
  const { lang = 'en' } = useParams<{ lang: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const tFn = (k: string, d?: string) => t(k, d ?? '') as string;
  const steps = useSteps(tFn);

  // Check for shared URL on mount
  const initialAnswers = useMemo(() => parseAnswersFromParams(searchParams), []);
  const [phase, setPhase] = useState<Phase>(initialAnswers ? 'results' : 'intro');
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [answers, setAnswers] = useState<Partial<QuizAnswers>>(initialAnswers || {});
  const [finalAnswers, setFinalAnswers] = useState<QuizAnswers | null>(initialAnswers);

  const isBeginner = answers.level === 'beginner';

  // Determine which steps to show (skip Q2 for beginners)
  const activeSteps = useMemo(
    () => isBeginner ? steps.filter((_, i) => i !== 1) : steps,
    [isBeginner, steps]
  );

  const totalSteps = activeSteps.length;
  const currentStep = activeSteps[stepIndex];
  const progressPct = phase === 'results' ? 100 : ((stepIndex + 1) / totalSteps) * 100;

  const { data: rackets = [], isLoading } = useRacketFinderQuery(finalAnswers, lang);

  const handleSelect = useCallback((value: string) => {
    if (!currentStep) return;
    const key = currentStep.key;

    const newAnswers = { ...answers };
    if (key === 'armFriendly') {
      newAnswers[key] = value === 'true';
    } else {
      (newAnswers as any)[key] = value;
    }

    // Auto-set style for beginners
    if (key === 'level' && value === 'beginner') {
      newAnswers.style = 'control';
    }

    setAnswers(newAnswers);

    trackEvent('quiz_step_completed', {
      step: stepIndex + 1,
      question: key,
      answer: value,
    });

    if (stepIndex === 0) {
      trackEvent('quiz_started');
    }

    // Move to next step or finish
    if (stepIndex < totalSteps - 1) {
      setDirection(1);
      setStepIndex(prev => prev + 1);
    } else {
      // Quiz complete
      const final = newAnswers as QuizAnswers;
      setFinalAnswers(final);
      setSearchParams({
        level: final.level,
        style: final.style,
        budget: String(final.budget),
        arm: String(final.armFriendly),
        weight: final.weight,
        shape: final.shape,
      }, { replace: true });
      trackEvent('quiz_completed', {
        ...final,
        budget: final.budget,
      });
      setPhase('results');
    }
  }, [answers, stepIndex, totalSteps, currentStep, setSearchParams]);

  const handleBack = useCallback(() => {
    if (stepIndex > 0) {
      setDirection(-1);
      setStepIndex(prev => prev - 1);
    } else {
      setPhase('intro');
    }
  }, [stepIndex]);

  const handleRetake = useCallback(() => {
    setAnswers({});
    setFinalAnswers(null);
    setStepIndex(0);
    setDirection(1);
    setPhase('intro');
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How do I choose a padel racket?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Consider your playing level, style (control/allround/power), budget, arm sensitivity, preferred weight and shape. Our quiz helps match these factors to the ideal racket.',
        },
      },
      {
        '@type': 'Question',
        name: 'What padel racket shape is best for beginners?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'Round-shaped rackets are best for beginners as they offer the largest sweet spot and maximum control, making it easier to develop proper technique.',
        },
      },
    ],
  };

  return (
    <MarketingLayout>
      <SEO
        title={t('quiz.seo.title', 'Padel Racket Finder — Find Your Perfect Racket')}
        description={t('quiz.seo.description', "Answer 5 quick questions and we'll recommend the perfect padel racket for your level, playing style, and budget.")}
        url={`/${lang}/racket-finder`}
        structuredData={structuredData}
      />

      <div className="container max-w-2xl mx-auto px-4 py-12 sm:py-16">
        {/* Intro text for SEO (always rendered but visually hidden during quiz/results) */}
        <div className={phase !== 'intro' ? 'sr-only' : ''}>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <h1 className="text-3xl sm:text-4xl font-bold text-foreground text-center mb-4 text-balance">
              {t('quiz.title', 'Find Your Perfect Padel Racket')}
            </h1>
            <p className="text-lg text-muted-foreground text-center mb-6 text-pretty max-w-xl mx-auto">
              {t('quiz.intro', "Not sure which padel racket to buy? Our racket finder quiz matches you with the ideal racket based on your playing level, style, budget, and physical needs. Whether you're a beginner looking for your first racket or an advanced player upgrading your weapon, we'll point you in the right direction.")}
            </p>
            <div className="flex justify-center">
              <Button
                size="lg"
                onClick={() => setPhase('quiz')}
                className="text-base px-8 py-6 rounded-xl shadow-md hover:shadow-lg transition-shadow"
              >
                {t('quiz.start', 'Start Quiz')} 🎾
              </Button>
            </div>
          </motion.div>
        </div>

        {/* Quiz flow */}
        {phase === 'quiz' && (
          <div>
            <div className="mb-8">
              <div className="flex items-center justify-between text-sm text-muted-foreground mb-2">
                <button
                  onClick={handleBack}
                  className="text-primary hover:text-primary/80 transition-colors font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                >
                  {t('quiz.back', '← Back')}
                </button>
                <span>
                  {stepIndex + 1} / {totalSteps}
                </span>
              </div>
              <Progress value={progressPct} className="h-2" />
            </div>

            <AnimatePresence mode="wait" custom={direction}>
              {currentStep && (
                <QuizQuestion
                  key={currentStep.key + stepIndex}
                  question={t(currentStep.questionKey)}
                  options={currentStep.options}
                  onSelect={handleSelect}
                  direction={direction}
                />
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Results */}
        {phase === 'results' && finalAnswers && (
          <QuizResults
            rackets={rackets}
            isLoading={isLoading}
            answers={finalAnswers}
            onRetake={handleRetake}
          />
        )}
      </div>
    </MarketingLayout>
  );
}
