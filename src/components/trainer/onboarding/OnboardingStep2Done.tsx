import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Copy, ExternalLink } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentLanguage } from '@/hooks/useLocalizedPath';
import { toast } from 'sonner';

interface OnboardingStep2DoneProps {
  onComplete: () => void;
}

export function OnboardingStep2Done({ onComplete }: OnboardingStep2DoneProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const lang = useCurrentLanguage();
  const [profileUrl, setProfileUrl] = useState('');

  useEffect(() => {
    if (user) loadSlug();
  }, [user]);

  const loadSlug = async () => {
    const { data: tp } = await supabase
      .from('trainer_profiles')
      .select('slug')
      .eq('user_id', user!.id)
      .maybeSingle();

    const slug = tp?.slug || user!.id;
    setProfileUrl(`${window.location.origin}/${lang}/trainer/${slug}`);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(profileUrl);
    toast.success('Profile link copied!');
  };

  const handlePreview = () => {
    window.open(profileUrl, '_blank');
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
        <h1 className="text-2xl font-bold">Your profile is ready! 🎉</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          Your profile is private for now. Preview it below, then head to your dashboard to add availability and publish when you're ready.
        </p>
      </div>

      {/* Profile link */}
      {profileUrl && (
        <div className="bg-muted rounded-lg p-4 max-w-sm mx-auto space-y-3">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Your profile link</p>
          <p className="text-sm font-mono break-all text-foreground">{profileUrl}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={handleCopyLink}>
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy link
            </Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={handlePreview}>
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Preview
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3 max-w-sm mx-auto">
        <Button size="lg" className="w-full" onClick={handleDashboard}>
          Go to your dashboard
        </Button>
        <button
          onClick={() => {
            onComplete();
            navigate('/app/trainer/profile');
          }}
          className="text-sm text-primary hover:underline"
        >
          Edit profile details
        </button>
      </div>

      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        You can publish anytime from your dashboard. Until then, you're not listed in the marketplace.
      </p>
    </div>
  );
}
