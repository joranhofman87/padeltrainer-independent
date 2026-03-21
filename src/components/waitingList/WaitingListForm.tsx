import { useState, useEffect } from 'react';
import WelcomeMessageCard from '@/components/shared/WelcomeMessageCard';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Bell, Check } from 'lucide-react';
import DayAvailabilityPicker, { DayAvailability } from '@/components/cycles/DayAvailabilityPicker';
import {
  createWaitingListEntry,
  hasActiveEntry,
  OwnerType,
  LessonType,
  TimeWindow,
} from '@/lib/waitingList';

interface WaitingListFormProps {
  ownerType: OwnerType;
  ownerId: string;
  ownerName: string;
  onSuccess?: () => void;
  welcomeMessage?: string | null;
}

export default function WaitingListForm({
  ownerType,
  ownerId,
  ownerName,
  onSuccess,
  welcomeMessage,
}: WaitingListFormProps) {
  const { t } = useTranslation('waitingList');
  const { profile } = useAuth();
  const { toast } = useToast();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAlreadyOnList, setIsAlreadyOnList] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(true);

  const [lessonType, setLessonType] = useState<LessonType>('private');
  const [hasGroup, setHasGroup] = useState(false);
  const [groupSize, setGroupSize] = useState<number>(2);
  const [rating, setRating] = useState<string>(profile?.skill_rating?.toString() || '');
  const [ratingSystem, setRatingSystem] = useState<string>((profile as any)?.rating_system || 'knltb');
  const [availability, setAvailability] = useState<DayAvailability>({});
  const [notes, setNotes] = useState('');

  // Check if player is already on the waiting list
  useEffect(() => {
    async function checkExisting() {
      if (!profile?.id) return;
      setCheckingStatus(true);
      const exists = await hasActiveEntry(profile.id, ownerType, ownerId);
      setIsAlreadyOnList(exists);
      setCheckingStatus(false);
    }
    checkExisting();
  }, [profile?.id, ownerType, ownerId]);

  // Convert DayAvailability to TimeWindow array
  const convertToTimeWindows = (dayAvail: DayAvailability): TimeWindow[] => {
    const windows: TimeWindow[] = [];
    Object.entries(dayAvail).forEach(([day, blocks]) => {
      blocks.forEach((block) => {
        windows.push({ day, start: block.start, end: block.end });
      });
    });
    return windows;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!profile?.id) {
      toast({
        title: 'Error',
        description: 'You must be logged in to join the waiting list',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);

    const preferredDays = Object.keys(availability);
    const preferredTimeWindows = convertToTimeWindows(availability);

    const { error } = await createWaitingListEntry({
      owner_type: ownerType,
      owner_id: ownerId,
      player_id: profile.id,
      lesson_type: lessonType,
      has_group: hasGroup,
      group_size: hasGroup ? groupSize : null,
      rating: rating ? parseFloat(rating) : null,
      rating_system: ratingSystem,
      preferred_days: preferredDays.length > 0 ? preferredDays : null,
      preferred_time_windows: preferredTimeWindows.length > 0 ? preferredTimeWindows : null,
      notes: notes.trim() || null,
    });

    setIsSubmitting(false);

    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    setIsSuccess(true);
    toast({
      title: t('success.title'),
      description: t('success.message'),
    });

    onSuccess?.();
  };

  if (checkingStatus) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (isAlreadyOnList) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="flex items-center gap-3 py-6">
          <Check className="h-5 w-5 text-primary" />
          <span className="text-sm font-medium">{t('alreadyOnList')}</span>
        </CardContent>
      </Card>
    );
  }

  if (isSuccess) {
    return (
      <Card className="border-green-500/30 bg-green-500/5">
        <CardContent className="text-center py-8 space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center mb-4">
            <Check className="h-6 w-6 text-green-600" />
          </div>
          <h3 className="text-lg font-semibold mb-1">{t('success.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('success.message')}</p>
          {welcomeMessage && (
            <WelcomeMessageCard
              message={welcomeMessage}
              ownerName={ownerName}
              labelKey={t('messageFrom', { name: ownerName })}
            />
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          {t('joinWaitingList')}
        </CardTitle>
        <CardDescription>{t('getNotified')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Lesson Type */}
          <div className="space-y-3">
            <Label>{t('form.lessonType')}</Label>
            <RadioGroup
              value={lessonType}
              onValueChange={(val) => setLessonType(val as LessonType)}
              className="grid grid-cols-2 gap-2"
            >
              {(['private', 'duo', 'group3', 'group4', 'kids'] as const).map((type) => (
                <div key={type} className="flex items-center space-x-2">
                  <RadioGroupItem value={type} id={`lesson-${type}`} />
                  <Label htmlFor={`lesson-${type}`} className="font-normal cursor-pointer">
                    {t(`form.lessonTypes.${type}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          {/* Has Group */}
          <div className="flex items-center justify-between">
            <Label htmlFor="has-group">{t('form.hasGroup')}</Label>
            <Switch
              id="has-group"
              checked={hasGroup}
              onCheckedChange={setHasGroup}
            />
          </div>

          {/* Group Size */}
          {hasGroup && (
            <div className="space-y-2">
              <Label htmlFor="group-size">{t('form.groupSize')}</Label>
              <Select
                value={groupSize.toString()}
                onValueChange={(val) => setGroupSize(parseInt(val))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[2, 3, 4, 5, 6, 7, 8].map((size) => (
                    <SelectItem key={size} value={size.toString()}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Rating */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="rating">{t('form.rating')}</Label>
              <Input
                id="rating"
                type="number"
                step="0.1"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
                placeholder="e.g., 5.0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rating-system">{t('form.ratingSystem')}</Label>
              <Select value={ratingSystem} onValueChange={setRatingSystem}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="knltb">KNLTB</SelectItem>
                  <SelectItem value="fip">FIP</SelectItem>
                  <SelectItem value="wpt">WPT</SelectItem>
                  <SelectItem value="ita">ITA</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Availability */}
          <div className="space-y-3">
            <Label>{t('form.availability')}</Label>
            <DayAvailabilityPicker
              value={availability}
              onChange={setAvailability}
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">{t('form.notes')}</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('form.notesPlaceholder')}
              rows={3}
            />
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('form.submitting')}
              </>
            ) : (
              t('form.submit')
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
