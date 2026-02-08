import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Target, Users, ClipboardList, Building2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Step1Data {
  goal: string;
  goalOtherText: string;
  followupAnswer: string;
}

interface OnboardingStep1GoalProps {
  initialData: Step1Data;
  onNext: (data: Step1Data) => void;
}

const GOALS = [
  { value: 'fill_slots', label: 'Fill empty slots', icon: Target },
  { value: 'new_players', label: 'Get more new players', icon: Users },
  { value: 'reduce_admin', label: 'Reduce admin', icon: ClipboardList },
  { value: 'club_sessions', label: 'Run sessions for a club', icon: Building2 },
  { value: 'other', label: 'Other', icon: HelpCircle },
];

const FOLLOWUP_QUESTIONS: Record<string, { question: string; options: string[] }> = {
  fill_slots: {
    question: 'How many hours do you want to fill per week?',
    options: ['2', '5', '10', '15+'],
  },
  new_players: {
    question: 'Who do you mostly coach?',
    options: ['Beginners', 'Intermediate', 'Advanced', 'Mixed'],
  },
  reduce_admin: {
    question: "What's the biggest headache right now?",
    options: ['Scheduling', 'Payments', 'Invoicing', 'No-shows'],
  },
  club_sessions: {
    question: 'Do you already coach at a club?',
    options: ['Yes', 'Not yet'],
  },
};

export function OnboardingStep1Goal({ initialData, onNext }: OnboardingStep1GoalProps) {
  const [goal, setGoal] = useState(initialData.goal);
  const [goalOtherText, setGoalOtherText] = useState(initialData.goalOtherText);
  const [followupAnswer, setFollowupAnswer] = useState(initialData.followupAnswer);

  const followup = goal && goal !== 'other' ? FOLLOWUP_QUESTIONS[goal] : null;
  const canProceed = goal && (goal !== 'other' || goalOtherText.trim()) && (goal === 'other' || followupAnswer);

  const handleGoalChange = (value: string) => {
    setGoal(value);
    setFollowupAnswer('');
    setGoalOtherText('');
  };

  return (
    <div className="space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">What's your main goal right now?</h1>
        <p className="text-muted-foreground">This helps us personalize your experience</p>
      </div>

      <div className="grid gap-3">
        {GOALS.map((g) => {
          const Icon = g.icon;
          const isSelected = goal === g.value;
          return (
            <button
              key={g.value}
              type="button"
              onClick={() => handleGoalChange(g.value)}
              className={cn(
                'flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all',
                isSelected
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border hover:border-primary/40 hover:bg-muted/50'
              )}
            >
              <div className={cn(
                'flex items-center justify-center h-10 w-10 rounded-lg shrink-0',
                isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}>
                <Icon className="h-5 w-5" />
              </div>
              <span className="font-medium">{g.label}</span>
            </button>
          );
        })}
      </div>

      {/* Other free-text */}
      {goal === 'other' && (
        <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
          <Label>Tell us more</Label>
          <Input
            placeholder="What are you looking to achieve?"
            value={goalOtherText}
            onChange={(e) => setGoalOtherText(e.target.value)}
            autoFocus
          />
        </div>
      )}

      {/* Conditional follow-up */}
      {followup && (
        <Card className="p-5 animate-in fade-in slide-in-from-top-2 duration-200">
          <Label className="text-base font-medium mb-3 block">{followup.question}</Label>
          <RadioGroup value={followupAnswer} onValueChange={setFollowupAnswer}>
            <div className="grid grid-cols-2 gap-2">
              {followup.options.map((opt) => (
                <label
                  key={opt}
                  className={cn(
                    'flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-all',
                    followupAnswer === opt
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-primary/40'
                  )}
                >
                  <RadioGroupItem value={opt} />
                  <span className="text-sm">{opt}</span>
                </label>
              ))}
            </div>
          </RadioGroup>
        </Card>
      )}

      <Button
        size="lg"
        className="w-full"
        disabled={!canProceed}
        onClick={() => onNext({ goal, goalOtherText, followupAnswer })}
      >
        Continue
      </Button>
    </div>
  );
}
