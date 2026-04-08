import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Copy, MessageCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Logo } from '@/components/Logo';
import type { QuizProfile } from '@/lib/redFlagQuizData';
import { useLocalizedPath } from '@/hooks/useLocalizedPath';

interface Props {
  profile: QuizProfile;
  onRetake: () => void;
}

export function RedFlagQuizResult({ profile, onRetake }: Props) {
  const { t } = useTranslation('marketing');
  const trainersPath = useLocalizedPath('/trainers');

  const redFlags = [
    t(`${profile.redFlagsKey}.0`),
    t(`${profile.redFlagsKey}.1`),
    t(`${profile.redFlagsKey}.2`),
  ];
  const greenFlag = t(profile.greenFlagKey);

  const shareUrl = `${window.location.origin}${window.location.pathname}?ref=challenge`;
  const shareText = t('redFlagQuiz.shareText', "I'm {{profile}}! What's your padel red flag?", {
    profile: t(profile.nameKey),
  });

  const copyLink = () => {
    navigator.clipboard.writeText(`${shareText} ${shareUrl}`);
    toast.success(t('redFlagQuiz.linkCopied', 'Link copied!'));
  };

  const shareWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${shareUrl}`)}`, '_blank');
  };

  const shareX = () => {
    window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`, '_blank');
  };

  return (
    <div className="w-full max-w-md mx-auto px-4">
      {/* Screenshot-worthy result card */}
      <div
        className="rounded-2xl p-6 text-white relative overflow-hidden"
        style={{ backgroundColor: `hsl(${profile.color})` }}
      >
        {/* Logo */}
        <div className="flex justify-center mb-4 opacity-80">
          <Logo className="h-5 brightness-0 invert" />
        </div>

        {/* Emoji */}
        <div className="text-6xl text-center mb-3">{profile.emoji}</div>

        {/* Profile name */}
        <h2 className="text-2xl md:text-3xl font-bold text-center mb-2">
          {t('redFlagQuiz.youAre', "You're")} {t(profile.nameKey)}
        </h2>

        {/* Tagline */}
        <p className="text-center text-white/90 italic mb-6">
          "{t(profile.taglineKey)}"
        </p>

        {/* Red flags */}
        <div className="mb-4">
          <p className="font-semibold mb-2">🚩 {t('redFlagQuiz.redFlagsLabel', 'Red Flags')}:</p>
          <ul className="space-y-1.5 text-sm text-white/90">
            {redFlags.map((flag, i) => (
              <li key={i}>• {flag}</li>
            ))}
          </ul>
        </div>

        {/* Green flag */}
        <div className="mb-4">
          <p className="font-semibold mb-1">🟢 {t('redFlagQuiz.greenFlagLabel', 'Green Flag')}:</p>
          <p className="text-sm text-white/90">{greenFlag}</p>
        </div>

        {/* URL on card */}
        <p className="text-center text-xs text-white/60 mt-4">
          padeltrainer.ai/playground/red-flag-quiz
        </p>
      </div>

      {/* Share buttons (below card) */}
      <div className="flex flex-col gap-3 mt-6">
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={copyLink}>
            <Copy className="h-4 w-4 mr-2" /> {t('redFlagQuiz.copyLink', 'Copy Link')}
          </Button>
          <Button variant="outline" className="flex-1" onClick={shareWhatsApp}>
            <MessageCircle className="h-4 w-4 mr-2" /> WhatsApp
          </Button>
          <Button variant="outline" className="flex-1" onClick={shareX}>
            𝕏
          </Button>
        </div>

        <Button variant="ghost" onClick={onRetake} className="w-full">
          <RotateCcw className="h-4 w-4 mr-2" /> {t('redFlagQuiz.retake', 'Retake Quiz')}
        </Button>

        <a href={trainersPath} className="block">
          <Button className="w-full bg-primary hover:bg-primary/90">
            {t('redFlagQuiz.findTrainer', 'Want to fix your red flags? Find a trainer →')}
          </Button>
        </a>
      </div>
    </div>
  );
}
