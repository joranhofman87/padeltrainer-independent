import { motion } from 'framer-motion';

export interface QuizOption {
  label: string;
  value: string;
  emoji: string;
}

interface QuizQuestionProps {
  question: string;
  options: QuizOption[];
  onSelect: (value: string) => void;
  direction: number;
}

const variants = {
  enter: (dir: number) => ({
    x: dir > 0 ? 120 : -120,
    opacity: 0,
    filter: 'blur(4px)',
  }),
  center: {
    x: 0,
    opacity: 1,
    filter: 'blur(0px)',
  },
  exit: (dir: number) => ({
    x: dir > 0 ? -120 : 120,
    opacity: 0,
    filter: 'blur(4px)',
  }),
};

export default function QuizQuestion({ question, options, onSelect, direction }: QuizQuestionProps) {
  return (
    <motion.div
      key={question}
      custom={direction}
      variants={variants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="w-full"
    >
      <h2 className="text-xl sm:text-2xl font-semibold text-foreground text-center mb-8 text-balance">
        {question}
      </h2>
      <div className="grid gap-3 max-w-md mx-auto">
        {options.map((opt, i) => (
          <motion.button
            key={opt.value}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.07, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            onClick={() => onSelect(opt.value)}
            className="flex items-center gap-4 w-full rounded-xl border-2 border-border bg-card px-5 py-4 text-left text-base font-medium text-card-foreground shadow-sm transition-[box-shadow,border-color,transform] duration-200 ease-out hover:border-primary hover:shadow-md active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <span className="text-2xl shrink-0" role="img" aria-hidden>{opt.emoji}</span>
            <span>{opt.label}</span>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
