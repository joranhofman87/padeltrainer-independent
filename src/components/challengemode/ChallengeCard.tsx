import { Challenge, DIFFICULTY_COLORS } from '@/lib/challengeModeData';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import logoWhite from '@/assets/logo-white.svg';

interface ChallengeCardProps {
  challenge: Challenge;
  isFlipping: boolean;
}

export default function ChallengeCard({ challenge, isFlipping }: ChallengeCardProps) {
  const { t } = useTranslation('marketing');
  const diffColor = DIFFICULTY_COLORS[challenge.difficulty];

  return (
    <div className="perspective-1000" style={{ perspective: '1000px' }}>
      <motion.div
        className="relative w-full max-w-[340px] mx-auto rounded-2xl overflow-hidden"
        style={{
          background: '#0b121d',
          boxShadow: `0 0 40px ${diffColor}30, 0 8px 32px rgba(0,0,0,0.4)`,
          border: `1px solid ${diffColor}40`,
          minHeight: '420px',
        }}
        animate={{
          rotateY: isFlipping ? [0, 90, 0] : 0,
        }}
        transition={{ duration: 0.5, ease: 'easeInOut' }}
      >
        {/* Top badges */}
        <div className="flex justify-between items-start p-4">
          <span
            className="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full"
            style={{
              background: challenge.mode === 'practice' ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.2)',
              color: challenge.mode === 'practice' ? '#60A5FA' : '#34D399',
            }}
          >
            {challenge.mode === 'practice'
              ? t('challengeMode.modePractice', 'Practice')
              : t('challengeMode.modeGame', 'Game')}
          </span>
          <span
            className="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full"
            style={{ background: `${diffColor}25`, color: diffColor }}
          >
            {t(`challengeMode.difficulty.${challenge.difficulty}`, challenge.difficulty)}
          </span>
        </div>

        {/* Icon */}
        <div className="text-center mt-2">
          <span className="text-6xl">{challenge.icon}</span>
        </div>

        {/* Title */}
        <h3 className="text-xl font-bold text-center px-6 mt-4" style={{ color: '#ffffff' }}>
          {challenge.title}
        </h3>

        {/* Description */}
        <p className="text-sm text-center px-6 mt-2" style={{ color: '#94A3B8' }}>
          {challenge.description}
        </p>

        {/* Tip box */}
        <div
          className="mx-4 mt-4 p-3 rounded-xl text-xs"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <span className="font-semibold" style={{ color: '#F59E0B' }}>
            💡 {t('challengeMode.whyThisWorks', 'Why this works:')}
          </span>
          <span className="ml-1" style={{ color: '#CBD5E1' }}>{challenge.tip}</span>
        </div>

        {/* Duration badge */}
        <div className="text-center mt-4 pb-3">
          <span
            className="inline-block text-xs px-3 py-1 rounded-full"
            style={{ background: 'rgba(255,255,255,0.08)', color: '#94A3B8' }}
          >
            ⏱ {challenge.duration}
          </span>
        </div>

        {/* Logo */}
        <div className="flex items-center justify-center pb-4 pt-2">
          <img src={logoWhite} alt="PadelTrainer.ai" className="h-5" />
        </div>
      </motion.div>
    </div>
  );
}
