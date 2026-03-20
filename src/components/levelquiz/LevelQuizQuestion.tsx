import { motion } from 'framer-motion';
import type { QuizQuestion } from '@/lib/levelQuizData';
import { cn } from '@/lib/utils';

interface Props {
  question: QuizQuestion;
  questionIndex: number;
  totalQuestions: number;
  selectedOption: number | null;
  onSelect: (optionIndex: number) => void;
  direction: number;
}

const optionLetters = ['A', 'B', 'C', 'D'];

export function LevelQuizQuestion({
  question,
  questionIndex,
  totalQuestions,
  selectedOption,
  onSelect,
  direction,
}: Props) {
  return (
    <motion.div
      key={questionIndex}
      initial={{ opacity: 0, x: direction > 0 ? 60 : -60, filter: 'blur(4px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: direction > 0 ? -60 : 60, filter: 'blur(4px)' }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="w-full"
    >
      <p className="text-sm text-muted-foreground mb-2">
        {questionIndex + 1} / {totalQuestions}
      </p>
      <h2 className="text-xl font-semibold mb-6 text-foreground text-wrap-balance">
        {question.question}
      </h2>

      <div className="space-y-3">
        {question.options.map((option, i) => (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={cn(
              'w-full text-left p-4 rounded-lg border-2 transition-all duration-150',
              'hover:border-primary/50 hover:shadow-sm',
              'active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              selectedOption === i
                ? 'border-primary bg-primary/5 shadow-sm'
                : 'border-border bg-card'
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors',
                  selectedOption === i
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {optionLetters[i]}
              </span>
              <span className="text-sm leading-relaxed pt-0.5">{option.text}</span>
            </div>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
