import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentLanguage } from '@/hooks/useLocalizedPath';

interface OnboardingStep4DoneProps {
  onComplete: () => void;
}

export function OnboardingStep4Done({ onComplete }: OnboardingStep4DoneProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const lang = useCurrentLanguage();

  const handlePreview = async () => {
    onComplete();
    // Navigate to public profile preview
    if (user) {
      const { data: tp } = await supabase
        .from('trainer_profiles')
        .select('slug')
        .eq('user_id', user.id)
        .maybeSingle();

      const slug = tp?.slug || user.id;
      navigate(`/${lang}/trainer/${slug}`);
    }
  };

  const handleDashboard = () => {
    onComplete();
    navigate('/app/trainer/get-started');
  };

  return (
    <div className="text-center space-y-8 py-8">
      <div className="flex justify-center">
        <div className="h-20 w-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
          <CheckCircle2 className="h-10 w-10 text-green-500" />
        </div>
      </div>

      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Nice — your setup is ready to review ✅</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          Your profile isn't visible to players yet. Next, review how it looks, then use your dashboard to add details and open more slots before publishing.
        </p>
      </div>

      <div className="space-y-3 max-w-sm mx-auto">
        <Button size="lg" className="w-full" onClick={handlePreview}>
          Review your profile
        </Button>
        <Button variant="outline" size="lg" className="w-full" onClick={handleDashboard}>
          Go to dashboard
        </Button>
        <button
          onClick={() => {
            onComplete();
            navigate('/app/trainer/profile');
          }}
          className="text-sm text-primary hover:underline"
        >
          Edit profile
        </button>
      </div>

      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        You can publish anytime. Until then, you're not listed in the marketplace.
      </p>
    </div>
  );
}
