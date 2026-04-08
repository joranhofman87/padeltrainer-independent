import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export default function SuggestChallengeForm() {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    mode: 'both',
    difficulty: 'medium',
    skill_benefit: '',
    submitter_name: '',
    submitter_email: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.description.trim()) return;

    setLoading(true);
    const { error } = await supabase.from('challenge_suggestions').insert({
      name: form.name.trim(),
      description: form.description.trim(),
      mode: form.mode,
      difficulty: form.difficulty,
      skill_benefit: form.skill_benefit.trim() || null,
      submitter_name: form.submitter_name.trim() || null,
      submitter_email: form.submitter_email.trim() || null,
    });
    setLoading(false);

    if (error) {
      toast.error(t('challengeMode.suggest.error', 'Something went wrong. Please try again.'));
      return;
    }

    toast.success(t('challengeMode.suggest.success', 'Thanks! If we add your challenge, you\'ll see it in the generator.'));
    setOpen(false);
    setForm({ name: '', description: '', mode: 'both', difficulty: 'medium', skill_benefit: '', submitter_name: '', submitter_email: '' });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="text-sm text-muted-foreground hover:text-primary transition-colors underline underline-offset-4">
          {t('challengeMode.suggest.cta', 'Suggest a Challenge')}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('challengeMode.suggest.title', 'Suggest a Challenge')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>{t('challengeMode.suggest.nameLabel', 'Challenge name')} *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
              maxLength={60}
              required
            />
          </div>
          <div>
            <Label>{t('challengeMode.suggest.descLabel', 'How does it work?')} *</Label>
            <textarea
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[80px]"
              value={form.description}
              onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
              maxLength={300}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>{t('challengeMode.suggest.modeLabel', 'Mode')}</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.mode}
                onChange={(e) => setForm(prev => ({ ...prev, mode: e.target.value }))}
              >
                <option value="practice">Practice</option>
                <option value="game">Game</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div>
              <Label>{t('challengeMode.suggest.diffLabel', 'Difficulty')}</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.difficulty}
                onChange={(e) => setForm(prev => ({ ...prev, difficulty: e.target.value }))}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
                <option value="chaos">Chaos</option>
              </select>
            </div>
          </div>
          <div>
            <Label>{t('challengeMode.suggest.skillLabel', 'What skill does it develop?')}</Label>
            <Input
              value={form.skill_benefit}
              onChange={(e) => setForm(prev => ({ ...prev, skill_benefit: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>{t('challengeMode.suggest.yourName', 'Your name')}</Label>
              <Input
                value={form.submitter_name}
                onChange={(e) => setForm(prev => ({ ...prev, submitter_name: e.target.value }))}
              />
            </div>
            <div>
              <Label>{t('challengeMode.suggest.email', 'Email')}</Label>
              <Input
                type="email"
                value={form.submitter_email}
                onChange={(e) => setForm(prev => ({ ...prev, submitter_email: e.target.value }))}
              />
            </div>
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? '...' : t('challengeMode.suggest.submit', 'Submit Challenge')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
