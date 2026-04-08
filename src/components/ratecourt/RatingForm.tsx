import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StarRating } from './StarRating';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CourtReviewInsert } from '@/hooks/useCourtReviews';

const CATEGORIES = [
  'surface', 'glass', 'lighting', 'space', 'changing_rooms',
  'booking', 'value', 'atmosphere', 'parking', 'beginner_friendly',
] as const;

interface RatingFormProps {
  locationName: string;
  onSubmit: (data: CourtReviewInsert) => void;
  isSubmitting: boolean;
  locationId: string;
}

export function RatingForm({ locationName, onSubmit, isSubmitting, locationId }: RatingFormProps) {
  const { t } = useTranslation('marketing');
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [bestThing, setBestThing] = useState('');
  const [improvement, setImprovement] = useState('');
  const [playerLevel, setPlayerLevel] = useState('');
  const [playFrequency, setPlayFrequency] = useState('');

  const ratedCount = Object.keys(ratings).length;
  const allRated = ratedCount === 10;

  const handleSubmit = () => {
    if (!allRated) return;
    onSubmit({
      location_id: locationId,
      rating_surface: ratings.surface,
      rating_glass: ratings.glass,
      rating_lighting: ratings.lighting,
      rating_space: ratings.space,
      rating_changing_rooms: ratings.changing_rooms,
      rating_booking: ratings.booking,
      rating_value: ratings.value,
      rating_atmosphere: ratings.atmosphere,
      rating_parking: ratings.parking,
      rating_beginner_friendly: ratings.beginner_friendly,
      best_thing: bestThing.trim() || undefined,
      improvement: improvement.trim() || undefined,
      player_level: playerLevel || undefined,
      play_frequency: playFrequency || undefined,
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">{locationName}</h2>
        <p className="text-sm text-muted-foreground">
          {t('rateMyCourtPage.progress', '{{count}}/10 categories rated', { count: ratedCount })}
        </p>
      </div>

      <div className="space-y-4">
        {CATEGORIES.map((cat) => (
          <div key={cat} className="flex items-center justify-between gap-4 py-2">
            <span className="text-sm font-medium text-foreground">
              {t(`rateMyCourtPage.categories.${cat}`)}
            </span>
            <StarRating
              value={ratings[cat] || 0}
              onChange={(v) => setRatings((prev) => ({ ...prev, [cat]: v }))}
            />
          </div>
        ))}
      </div>

      <div className="space-y-4 pt-4 border-t">
        <div>
          <label className="text-sm font-medium text-foreground block mb-1">
            {t('rateMyCourtPage.bestThing', 'What did you like most?')}
          </label>
          <Textarea
            value={bestThing}
            onChange={(e) => setBestThing(e.target.value.slice(0, 200))}
            placeholder={t('rateMyCourtPage.bestThingPlaceholder', 'Great courts, friendly atmosphere...')}
            rows={2}
          />
          <p className="text-xs text-muted-foreground mt-1">{bestThing.length}/200</p>
        </div>

        <div>
          <label className="text-sm font-medium text-foreground block mb-1">
            {t('rateMyCourtPage.improvement', 'What could be improved?')}
          </label>
          <Textarea
            value={improvement}
            onChange={(e) => setImprovement(e.target.value.slice(0, 200))}
            placeholder={t('rateMyCourtPage.improvementPlaceholder', 'Better lighting, more parking...')}
            rows={2}
          />
          <p className="text-xs text-muted-foreground mt-1">{improvement.length}/200</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">
              {t('rateMyCourtPage.yourLevel', 'Your level')}
            </label>
            <Select value={playerLevel} onValueChange={setPlayerLevel}>
              <SelectTrigger><SelectValue placeholder={t('rateMyCourtPage.selectLevel', 'Select...')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="beginner">{t('rateMyCourtPage.levels.beginner', 'Beginner')}</SelectItem>
                <SelectItem value="intermediate">{t('rateMyCourtPage.levels.intermediate', 'Intermediate')}</SelectItem>
                <SelectItem value="advanced">{t('rateMyCourtPage.levels.advanced', 'Advanced')}</SelectItem>
                <SelectItem value="pro">{t('rateMyCourtPage.levels.pro', 'Pro')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground block mb-1">
              {t('rateMyCourtPage.howOften', 'How often do you play here?')}
            </label>
            <Select value={playFrequency} onValueChange={setPlayFrequency}>
              <SelectTrigger><SelectValue placeholder={t('rateMyCourtPage.selectFrequency', 'Select...')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="first_time">{t('rateMyCourtPage.frequency.first_time', 'First time')}</SelectItem>
                <SelectItem value="few_times">{t('rateMyCourtPage.frequency.few_times', 'A few times')}</SelectItem>
                <SelectItem value="regularly">{t('rateMyCourtPage.frequency.regularly', 'Regularly')}</SelectItem>
                <SelectItem value="home_club">{t('rateMyCourtPage.frequency.home_club', 'Home club')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <Button
        onClick={handleSubmit}
        disabled={!allRated || isSubmitting}
        className="w-full"
        size="lg"
      >
        {isSubmitting
          ? t('rateMyCourtPage.submitting', 'Submitting...')
          : t('rateMyCourtPage.submitReview', 'Submit Review')}
      </Button>
    </div>
  );
}
