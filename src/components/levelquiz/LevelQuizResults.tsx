import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { LocalizedLink } from '@/components/LocalizedLink';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Check, TrendingUp, BookOpen, Target, Newspaper,
  Share2, RotateCcw, Copy, ExternalLink,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import posthog from 'posthog-js';
import {
  getLevelInfo, getNextLevel, getCountryRating, getCountryLabel,
  CONTENT_LINKS, QUIZ_COUNTRIES,
  type QuizCountry,
} from '@/lib/levelQuizData';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface Props {
  level: number;
  country: QuizCountry;
  onCountryChange: (c: QuizCountry) => void;
  onRetake: () => void;
}

export function LevelQuizResults({ level, country, onCountryChange, onRetake }: Props) {
  const { t } = useTranslation('marketing');
  const { lang } = useParams<{ lang: string }>();
  const currentLang = lang ?? 'en';
  const { toast } = useToast();

  const info = getLevelInfo(level);
  const nextLevel = getNextLevel(level);
  const countryRating = getCountryRating(country, level);
  const countryLabel = getCountryLabel(country);
  const content = CONTENT_LINKS[info.racketLevel];
  const gaugePercent = (level / 7) * 100;

  const shareUrl = `https://padeltrainer.ai/${currentLang}/tools/padel-level-test?result=${level}&country=${country}`;

  const handleShare = (method: string) => {
    const text = t('levelQuiz.shareText', { level: level.toFixed(1), title: info.title })
      .replace('🎾', '🎾');
    posthog.capture('level_quiz_shared', { level, method });

    if (method === 'copy') {
      navigator.clipboard.writeText(`${text}\n${shareUrl}`);
      toast({ title: t('levelQuiz.linkCopied', 'Link copied!') });
    } else if (method === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${shareUrl}`)}`, '_blank');
    } else if (method === 'twitter') {
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`, '_blank');
    } else if (method === 'facebook') {
      window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`, '_blank');
    }
  };

  const trackContentClick = (contentType: string, slug: string) => {
    posthog.capture('level_quiz_content_click', { level, contentType, contentSlug: slug });
  };

  const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.08 } } };
  const fadeUp = {
    hidden: { opacity: 0, y: 16, filter: 'blur(4px)' },
    visible: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const } },
  };

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={stagger}
      className="max-w-2xl mx-auto space-y-8"
    >
      {/* ── Level gauge ──────────────────── */}
      <motion.div variants={fadeUp} className="text-center space-y-4">
        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('levelQuiz.yourLevel')}
        </p>
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-6xl font-bold tabular-nums text-foreground">{level.toFixed(1)}</span>
          <span className="text-2xl text-muted-foreground">/ 7.0</span>
        </div>
        <Progress value={gaugePercent} className="h-3 max-w-xs mx-auto" />
        <Badge variant="secondary" className="text-base px-4 py-1">
          {info.title}
        </Badge>
      </motion.div>

      {/* ── Country equivalent ────────────── */}
      <motion.div variants={fadeUp} className="bg-card border rounded-lg p-5 text-center space-y-3">
        <Select value={country} onValueChange={(v) => onCountryChange(v as QuizCountry)}>
          <SelectTrigger className="w-full max-w-xs mx-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {QUIZ_COUNTRIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-lg font-semibold text-foreground">
          {t('levelQuiz.equivalentIn', { country: countryLabel.replace(/^.+?\s/, '') })}:{' '}
          <span className="text-primary">{countryRating}</span>
        </p>
      </motion.div>

      {/* ── Description ───────────────────── */}
      <motion.p variants={fadeUp} className="text-muted-foreground leading-relaxed">
        {info.description}
      </motion.p>

      {/* ── Strengths ─────────────────────── */}
      <motion.div variants={fadeUp} className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2 text-foreground">
          <Check className="h-4 w-4 text-green-600" />
          {t('levelQuiz.strengths')}
        </h3>
        <ul className="space-y-2">
          {info.strengths.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
              {s}
            </li>
          ))}
        </ul>
      </motion.div>

      {/* ── Focus areas ───────────────────── */}
      <motion.div variants={fadeUp} className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2 text-foreground">
          <TrendingUp className="h-4 w-4 text-amber-600" />
          {t('levelQuiz.focusAreas', { nextLevel: nextLevel.toFixed(1) })}
        </h3>
        <ul className="space-y-2">
          {info.focusAreas.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
              <TrendingUp className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
              {f}
            </li>
          ))}
        </ul>
      </motion.div>

      {/* ── Recommended reading ────────────── */}
      <motion.div variants={fadeUp} className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2 text-foreground">
          <BookOpen className="h-4 w-4" />
          {t('levelQuiz.recommendedReading')}
        </h3>
        <div className="grid gap-2">
          {content.articles.map((a) => (
            <LocalizedLink
              key={a.slug}
              to={`/learn/${a.slug}`}
              className="text-sm text-primary hover:underline flex items-center gap-1.5"
              onClick={() => trackContentClick('learningArticle', a.slug)}
            >
              <BookOpen className="h-3.5 w-3.5" /> {a.title}
            </LocalizedLink>
          ))}
        </div>
      </motion.div>

      {/* ── Strokes to master ─────────────── */}
      <motion.div variants={fadeUp} className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2 text-foreground">
          <Target className="h-4 w-4" />
          {t('levelQuiz.strokesToMaster')}
        </h3>
        <div className="flex flex-wrap gap-2">
          {content.strokes.map((s) => (
            <LocalizedLink
              key={s.slug}
              to={`/padel-strokes/${s.slug}`}
              onClick={() => trackContentClick('stroke', s.slug)}
            >
              <Badge variant="outline" className="hover:bg-primary/5 cursor-pointer">
                {s.title}
              </Badge>
            </LocalizedLink>
          ))}
        </div>
      </motion.div>

      {/* ── Blog posts ────────────────────── */}
      <motion.div variants={fadeUp} className="space-y-3">
        <h3 className="font-semibold flex items-center gap-2 text-foreground">
          <Newspaper className="h-4 w-4" />
          {t('levelQuiz.fromBlog')}
        </h3>
        <div className="grid gap-2">
          {content.blogPosts.map((b) => (
            <LocalizedLink
              key={b.slug}
              to={`/blog/${b.slug}`}
              className="text-sm text-primary hover:underline flex items-center gap-1.5"
              onClick={() => trackContentClick('blogPost', b.slug)}
            >
              <Newspaper className="h-3.5 w-3.5" /> {b.title}
            </LocalizedLink>
          ))}
        </div>
      </motion.div>

      {/* ── Racket finder CTA ─────────────── */}
      <motion.div variants={fadeUp} className="bg-primary/5 border border-primary/20 rounded-lg p-6 text-center space-y-3">
        <p className="font-semibold text-foreground">{t('levelQuiz.findRacket')}</p>
        <p className="text-sm text-muted-foreground">{content.racketQuizCta}</p>
        <LocalizedLink
          to={`/racket-finder?level=${info.racketLevel}`}
          onClick={() => trackContentClick('racketQuiz', 'racket-finder')}
        >
          <Button>
            {t('levelQuiz.takeRacketQuiz')} <ExternalLink className="h-4 w-4 ml-1.5" />
          </Button>
        </LocalizedLink>
      </motion.div>

      {/* ── Share & retake ────────────────── */}
      <motion.div variants={fadeUp} className="flex flex-col items-center gap-4 pt-4">
        <p className="text-sm font-medium text-muted-foreground">{t('levelQuiz.shareResult')}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => handleShare('copy')}>
            <Copy className="h-4 w-4 mr-1.5" /> Link
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleShare('whatsapp')}>
            WhatsApp
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleShare('twitter')}>
            X
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleShare('facebook')}>
            Facebook
          </Button>
        </div>
        <Button variant="ghost" onClick={onRetake} className="gap-2">
          <RotateCcw className="h-4 w-4" /> {t('levelQuiz.retakeQuiz')}
        </Button>
      </motion.div>
    </motion.div>
  );
}
