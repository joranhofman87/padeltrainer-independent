import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Plus, Edit, Trash2, Clock, Users, Euro, MapPin, CreditCard, Copy, Eye, EyeOff } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { createLesson, getTrainerLessons, updateLesson, deleteLesson, type Lesson } from '@/lib/lessons';
import { LessonLocationPicker } from '@/components/trainer/LessonLocationPicker';
import { RequestClubDialog } from '@/components/trainer/RequestClubDialog';

export default function ManageLessons() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loadingLessons, setLoadingLessons] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [requestClubOpen, setRequestClubOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [saving, setSaving] = useState(false);
  
  // Form state
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    duration_minutes: 60,
    price: 50,
    max_participants: 4,
    min_skill_rating: '',
    max_skill_rating: '',
    location: '',
    is_active: true,
    payment_timing: 'upfront' as 'upfront' | 'after',
  });

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchLessons();
    }
  }, [user, role]);

  const fetchLessons = async () => {
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();
    
    if (trainerProfile) {
      const { data, error } = await getTrainerLessons(trainerProfile.id);
      if (data) {
        setLessons(data as Lesson[]);
      }
      if (error) {
        toast({
          title: 'Error',
          description: 'Failed to load lessons',
          variant: 'destructive',
        });
      }
    }
    setLoadingLessons(false);
  };

  const resetForm = () => {
    setFormData({
      title: '',
      description: '',
      duration_minutes: 60,
      price: 50,
      max_participants: 4,
      min_skill_rating: '',
      max_skill_rating: '',
      location: '',
      is_active: true,
      payment_timing: 'upfront',
    });
    setEditingLesson(null);
  };

  const openEditDialog = (lesson: Lesson) => {
    setEditingLesson(lesson);
    setFormData({
      title: lesson.title,
      description: lesson.description || '',
      duration_minutes: lesson.duration_minutes,
      price: lesson.price,
      max_participants: lesson.max_participants,
      min_skill_rating: lesson.min_skill_rating?.toString() || '',
      max_skill_rating: lesson.max_skill_rating?.toString() || '',
      location: lesson.location || '',
      is_active: lesson.is_active,
      payment_timing: lesson.payment_timing || 'upfront',
    });
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.title || formData.price <= 0) {
      toast({
        title: 'Validation Error',
        description: 'Please fill in all required fields',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);

    try {
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user!.id)
        .single();

      if (!trainerProfile) {
        throw new Error('Trainer profile not found');
      }

      const lessonData = {
        title: formData.title,
        description: formData.description || null,
        duration_minutes: formData.duration_minutes,
        price: formData.price,
        max_participants: formData.max_participants,
        min_skill_rating: formData.min_skill_rating ? parseFloat(formData.min_skill_rating) : null,
        max_skill_rating: formData.max_skill_rating ? parseFloat(formData.max_skill_rating) : null,
        location: formData.location || null,
        is_active: formData.is_active,
        is_recurring: false,
        recurrence_type: null,
        recurrence_day: null,
        recurrence_time: null,
        recurrence_count: null,
        recurrence_end_date: null,
        start_date: null,
        payment_timing: formData.payment_timing,
      };

      if (editingLesson) {
        const { error } = await updateLesson(editingLesson.id, lessonData);
        if (error) throw error;
        toast({ title: 'Success', description: 'Lesson updated successfully' });
      } else {
        const { error } = await createLesson(trainerProfile.id, lessonData);
        if (error) throw error;
        toast({ title: 'Success', description: 'Lesson created successfully' });
      }

      setDialogOpen(false);
      resetForm();
      fetchLessons();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to save lesson',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (lessonId: string) => {
    if (!confirm('Are you sure you want to delete this lesson?')) return;

    const { error } = await deleteLesson(lessonId);
    if (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete lesson',
        variant: 'destructive',
      });
    } else {
      toast({ title: 'Success', description: 'Lesson deleted' });
      fetchLessons();
    }
  };

  const handleDuplicate = async (lesson: Lesson) => {
    try {
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user!.id)
        .single();

      if (!trainerProfile) {
        throw new Error('Trainer profile not found');
      }

      const lessonData = {
        title: `${lesson.title} (copy)`,
        description: lesson.description || null,
        duration_minutes: lesson.duration_minutes,
        price: lesson.price,
        max_participants: lesson.max_participants,
        min_skill_rating: lesson.min_skill_rating,
        max_skill_rating: lesson.max_skill_rating,
        location: lesson.location || null,
        is_active: true,
        is_recurring: false,
        recurrence_type: null,
        recurrence_day: null,
        recurrence_time: null,
        recurrence_count: null,
        recurrence_end_date: null,
        start_date: null,
        payment_timing: lesson.payment_timing,
      };

      const { error } = await createLesson(trainerProfile.id, lessonData);
      if (error) throw error;
      
      toast({ title: 'Success', description: 'Lesson duplicated successfully' });
      fetchLessons();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to duplicate lesson',
        variant: 'destructive',
      });
    }
  };

  if (loading || loadingLessons) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Manage Lessons</h1>
            <p className="text-sm text-muted-foreground">Create and edit your training offerings</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-muted-foreground">
              {lessons.length} lesson{lessons.length !== 1 ? 's' : ''} created
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Add Lesson
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingLesson ? 'Edit Lesson' : 'Create New Lesson'}</DialogTitle>
                <DialogDescription>
                  {editingLesson ? 'Update your lesson details' : 'Define a new training session for players'}
                </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    placeholder="e.g., Beginner Padel Fundamentals"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Describe what players will learn..."
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="duration">Duration (minutes)</Label>
                    <Input
                      id="duration"
                      type="number"
                      min={15}
                      step={15}
                      value={formData.duration_minutes}
                      onChange={(e) => setFormData({ ...formData, duration_minutes: parseInt(e.target.value) || 60 })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="price">Price (€) *</Label>
                    <Input
                      id="price"
                      type="number"
                      min={0}
                      step={5}
                      value={formData.price}
                      onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="participants">Max Participants</Label>
                  <Input
                    id="participants"
                    type="number"
                    min={1}
                    max={20}
                    value={formData.max_participants}
                    onChange={(e) => setFormData({ ...formData, max_participants: parseInt(e.target.value) || 1 })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="minRating">Min KNLTB Rating</Label>
                    <Input
                      id="minRating"
                      type="number"
                      step={0.1}
                      min={0.1}
                      max={9.9}
                      placeholder="e.g., 3.0"
                      value={formData.min_skill_rating}
                      onChange={(e) => setFormData({ ...formData, min_skill_rating: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxRating">Max KNLTB Rating</Label>
                    <Input
                      id="maxRating"
                      type="number"
                      step={0.1}
                      min={0.1}
                      max={9.9}
                      placeholder="e.g., 7.0"
                      value={formData.max_skill_rating}
                      onChange={(e) => setFormData({ ...formData, max_skill_rating: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Location</Label>
                  <LessonLocationPicker
                    value={null}
                    onChange={(locationId, locationName) => {
                      setFormData({ ...formData, location: locationName || '' });
                    }}
                    onRequestNewClub={() => setRequestClubOpen(true)}
                  />
                  {formData.location && (
                    <p className="text-xs text-muted-foreground">
                      Selected: {formData.location}
                    </p>
                  )}
                </div>

                {/* Payment Timing Section */}
                <div className="border-t pt-4 mt-4">
                  <div className="flex items-center gap-2 mb-4">
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                    <Label>Payment Timing</Label>
                  </div>
                  <RadioGroup
                    value={formData.payment_timing}
                    onValueChange={(value: 'upfront' | 'after') => setFormData({ ...formData, payment_timing: value })}
                    className="space-y-3"
                  >
                    <div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer">
                      <RadioGroupItem value="upfront" id="upfront" className="mt-1" />
                      <Label htmlFor="upfront" className="cursor-pointer flex-1">
                        <div className="font-medium">Pay Upfront</div>
                        <p className="text-sm text-muted-foreground">
                          Players pay when booking. Recommended for most lessons.
                        </p>
                      </Label>
                    </div>
                    <div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer">
                      <RadioGroupItem value="after" id="after" className="mt-1" />
                      <Label htmlFor="after" className="cursor-pointer flex-1">
                        <div className="font-medium">Pay After Lesson</div>
                        <p className="text-sm text-muted-foreground">
                          Payment expected after lesson completes. Mark as cancelled to waive payment.
                        </p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>

                {/* Active Toggle */}
                <div className="flex items-center justify-between border-t pt-4 mt-4">
                  <div>
                    <Label htmlFor="active">Active</Label>
                    <p className="text-sm text-muted-foreground">Visible to players</p>
                  </div>
                  <Switch
                    id="active"
                    checked={formData.is_active}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={saving}>
                  {saving ? 'Saving...' : editingLesson ? 'Update Lesson' : 'Create Lesson'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {lessons.length === 0 ? (
          <Card className="p-12 text-center">
            <div className="text-6xl mb-4">📚</div>
            <h3 className="text-xl font-semibold mb-2">No lessons yet</h3>
            <p className="text-muted-foreground mb-6">
              Create your first lesson to start accepting bookings from players
            </p>
            <Button onClick={() => setDialogOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Your First Lesson
            </Button>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {lessons.map((lesson) => (
              <Card key={lesson.id} className={!lesson.is_active ? 'opacity-60' : ''}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <CardTitle className="text-lg">{lesson.title}</CardTitle>
                      <div className="flex flex-wrap gap-1">
                        <Badge 
                          variant={lesson.is_active ? "default" : "secondary"}
                          className={`text-xs gap-1 ${lesson.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : ''}`}
                        >
                          {lesson.is_active ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                          {lesson.is_active ? 'Visible' : 'Hidden'}
                        </Badge>
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${lesson.payment_timing === 'after' ? 'border-orange-300 text-orange-600' : 'border-green-300 text-green-600'}`}
                        >
                          Pay {lesson.payment_timing === 'after' ? 'After' : 'Upfront'}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditDialog(lesson)}
                        title="Edit lesson"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleDuplicate(lesson)}
                        title="Duplicate lesson"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => handleDelete(lesson.id)}
                        title="Delete lesson"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {lesson.description || 'No description'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      {lesson.duration_minutes} min
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Users className="h-4 w-4" />
                      Max {lesson.max_participants}
                    </div>
                    <div className="flex items-center gap-2 font-semibold text-primary">
                      <Euro className="h-4 w-4" />
                      €{lesson.price}
                    </div>
                    {lesson.location && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        <span className="truncate">{lesson.location}</span>
                      </div>
                    )}
                  </div>
                  {(lesson.min_skill_rating || lesson.max_skill_rating) && (
                    <div className="mt-3 pt-3 border-t text-sm text-muted-foreground">
                      Rating: {lesson.min_skill_rating || '0'} - {lesson.max_skill_rating || '10'}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <RequestClubDialog open={requestClubOpen} onOpenChange={setRequestClubOpen} />
    </div>
  );
}
