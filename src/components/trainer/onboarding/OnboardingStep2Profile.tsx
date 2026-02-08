import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { TrainerLocationPicker, TrainerLocationSelection } from '@/components/locations/TrainerLocationPicker';
import { SpecializationsPicker } from '@/components/trainer/SpecializationsPicker';
import { Phone } from 'lucide-react';
import { toast } from 'sonner';

interface OnboardingStep2ProfileProps {
  onNext: () => void;
  onBack: () => void;
}

export function OnboardingStep2Profile({ onNext, onBack }: OnboardingStep2ProfileProps) {
  const { user } = useAuth();
  const [fullName, setFullName] = useState('');
  const [bio, setBio] = useState('');
  const [phone, setPhone] = useState('');
  const [specializations, setSpecializations] = useState<string[]>([]);
  const [locations, setLocations] = useState<TrainerLocationSelection[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) loadExistingData();
  }, [user]);

  const loadExistingData = async () => {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, bio, phone')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (profile) {
        setFullName(profile.full_name || '');
        setBio(profile.bio || '');
        setPhone(profile.phone || '');
      }

      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id, specializations')
        .eq('user_id', user!.id)
        .maybeSingle();

      if (trainerProfile) {
        setSpecializations(trainerProfile.specializations || []);

        // Load existing locations
        const { data: trainerLocations } = await supabase
          .from('trainer_locations')
          .select('location_id, is_primary, relationship_type')
          .eq('trainer_id', trainerProfile.id);

        if (trainerLocations) {
          setLocations(trainerLocations.map(l => ({
            locationId: l.location_id,
            isPrimary: l.is_primary,
            relationshipType: l.relationship_type as any,
          })));
        }
      }
    } catch (e) {
      console.error('Failed to load profile data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user || !fullName.trim() || !bio.trim()) return;

    setSaving(true);
    try {
      // Update profiles table
      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          full_name: fullName.trim(),
          bio: bio.trim(),
          phone: phone.trim() || null,
        })
        .eq('user_id', user.id);

      if (profileError) throw profileError;

      // Get trainer profile ID
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .single();

      if (!trainerProfile) throw new Error('Trainer profile not found');

      // Update specializations
      const { error: specError } = await supabase
        .from('trainer_profiles')
        .update({ specializations })
        .eq('id', trainerProfile.id);

      if (specError) throw specError;

      // Sync locations: delete existing, re-insert
      await supabase
        .from('trainer_locations')
        .delete()
        .eq('trainer_id', trainerProfile.id);

      if (locations.length > 0) {
        const { error: locError } = await supabase
          .from('trainer_locations')
          .insert(
            locations.map(l => ({
              trainer_id: trainerProfile.id,
              location_id: l.locationId,
              is_primary: l.isPrimary,
              relationship_type: l.relationshipType,
            }))
          );
        if (locError) throw locError;
      }

      onNext();
    } catch (error: any) {
      console.error('Error saving profile:', error);
      toast.error('Failed to save profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const canProceed = fullName.trim().length > 0 && bio.trim().length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Build your profile</h1>
        <p className="text-muted-foreground">Players will see this when browsing trainers</p>
      </div>

      <div className="space-y-5">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="fullName">Name *</Label>
          <Input
            id="fullName"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Your full name"
          />
        </div>

        {/* About */}
        <div className="space-y-2">
          <Label htmlFor="bio">About *</Label>
          <Textarea
            id="bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell players about your coaching style, experience, and what makes your lessons special..."
            rows={3}
          />
          <p className="text-xs text-muted-foreground">1–2 sentences is plenty</p>
        </div>

        {/* Training Locations */}
        <div className="space-y-2">
          <Label>Training locations <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <TrainerLocationPicker
            selectedLocations={locations}
            onChange={setLocations}
          />
        </div>

        {/* Specializations */}
        <div className="space-y-2">
          <Label>Specializations <span className="text-muted-foreground text-xs">(optional)</span></Label>
          <SpecializationsPicker
            selectedSpecializations={specializations}
            onChange={setSpecializations}
          />
        </div>

        {/* Phone */}
        <div className="space-y-2">
          <Label htmlFor="phone" className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            Phone number <span className="text-muted-foreground text-xs">(optional)</span>
          </Label>
          <Input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+31 6 12345678"
          />
          <p className="text-xs text-muted-foreground">For booking updates</p>
        </div>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" size="lg" onClick={onBack} className="flex-1">
          Back
        </Button>
        <Button
          size="lg"
          className="flex-1"
          disabled={!canProceed || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving...' : 'Continue'}
        </Button>
      </div>
    </div>
  );
}
