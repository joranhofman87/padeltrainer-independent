import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import type { QuizQuestion } from '@/lib/redFlagQuizData';

interface Props {
  question: QuizQuestion;
  questionIndex: number;
  total: number;
  onAnswer: (optionIndex: number) => void;
}

export function RedFlagQuizQuestion({ question, questionIndex, total, onAnswer }: Props) {
  const { t } = useTranslation('marketing');
  const [selected, setSelected] = useState<number | null>(null);

  const handleSelect = (idx: number) => {
    if (selected !== null) return;
    setSelected(idx);
    setTimeout(() => onAnswer(idx), 500);
  };

  const labels = ['A', 'B', 'C', 'D'];

  return (
    <motion.div
      key={questionIndex}
      initial={{ x: 80, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -80, opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="w-full max-w-lg mx-auto px-4"
    >
      {/* Progress */}
      <div className="mb-6">
        <div className="flex justify-between text-sm text-muted-foreground mb-2">
          <span>{t('redFlagQuiz.questionOf', 'Question {{current}} of {{total}}', { current: questionIndex + 1, total })}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${((questionIndex + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Question */}
      <p className="text-lg md:text-xl font-semibold text-foreground mb-6 leading-relaxed">
        {t(question.scenarioKey)}
      </p>

      {/* Options */}
      <div className="flex flex-col gap-3">
        {question.options.map((option, idx) => (
          <button
            key={idx}
            onClick={() => handleSelect(idx)}
            className={`text-left p-4 rounded-xl border-2 transition-all duration-200 ${
              selected === idx
                ? 'border-primary bg-primary/10 scale-[1.02]'
                : 'border-border hover:border-primary/50 hover:bg-muted/50'
            } ${selected !== null && selected !== idx ? 'opacity-50' : ''}`}
          >
            <span className="font-bold text-primary mr-2">{labels[idx]})</span>
            <span className="text-foreground">{t(option.textKey)}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
