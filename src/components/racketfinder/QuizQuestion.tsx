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
    x: dir > 0 ? 80 : -80,
    opacity: 0,
    filter: 'blur(6px)',
  }),
  center: {
    x: 0,
    opacity: 1,
    filter: 'blur(0px)',
  },
  exit: (dir: number) => ({
    x: dir > 0 ? -80 : 80,
    opacity: 0,
    filter: 'blur(6px)',
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
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="w-full"
    >
      <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-10 text-balance leading-tight">
        {question}
      </h2>
      <div className="grid gap-3 max-w-md mx-auto">
        {options.map((opt, i) => (
          <motion.button
            key={opt.value}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 + i * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            onClick={() => onSelect(opt.value)}
            className="group relative flex items-center gap-4 w-full rounded-xl border-2 border-border bg-card pl-5 pr-5 py-4 text-left text-base font-medium text-card-foreground transition-all duration-200 ease-out hover:border-primary hover:shadow-md hover:bg-primary/[0.03] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {/* Left accent bar */}
            <div className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-primary/0 group-hover:bg-primary transition-colors duration-200" />
            {/* Number indicator */}
            <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-sm font-bold text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors duration-200">
              {i + 1}
            </span>
            <span className="leading-snug">{opt.label}</span>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
