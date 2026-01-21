import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Edit2, Trash2, Copy, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { ClubNavigation } from "@/components/club/ClubNavigation";
import { getUserClubProfiles, getClubTrainers } from "@/lib/club";
import { supabase } from "@/integrations/supabase/client";

interface Lesson {
  id: string;
  trainer_id: string;
  title: string;
  description: string | null;
  duration_minutes: number;
  price: number;
  max_participants: number;
  location: string | null;
  is_active: boolean;
  payment_timing: string;
}

interface Trainer {
  id: string;
  name: string;
  user_id: string;
}

export default function ClubLessons() {
  const { t } = useTranslation("club");
  const { t: tTrainer } = useTranslation("trainer");
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [clubProfileId, setClubProfileId] = useState<string | null>(null);
  const [clubName, setClubName] = useState<string>("");
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>("all");
  
  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [lessonToDelete, setLessonToDelete] = useState<Lesson | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  
  // Form state
  const [formTrainerId, setFormTrainerId] = useState<string>("");
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formDuration, setFormDuration] = useState(60);
  const [formPrice, setFormPrice] = useState(0);
  const [formMaxParticipants, setFormMaxParticipants] = useState(1);
  const [formLocation, setFormLocation] = useState("");
  const [formIsActive, setFormIsActive] = useState(true);
  const [formPaymentTiming, setFormPaymentTiming] = useState<"upfront" | "after">("upfront");

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function loadData() {
      if (!user) return;
      
      const clubs = await getUserClubProfiles(user.id);
      if (clubs.length > 0) {
        setClubProfileId(clubs[0].id);
        setClubName(clubs[0].location?.name || "Club");
        
        // Load trainers
        const clubTrainers = await getClubTrainers(clubs[0].id);
        const trainerList: Trainer[] = [];
        
        for (const t of clubTrainers) {
          const trainer = t.trainer_profiles as any;
          // Get trainer's name from profile
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("user_id", trainer.user_id)
            .single();
          
          trainerList.push({
            id: trainer.id,
            name: profile?.full_name || "Unknown",
            user_id: trainer.user_id,
          });
        }
        
        setTrainers(trainerList);
        
        // Load lessons for all trainers
        if (trainerList.length > 0) {
          const trainerIds = trainerList.map(t => t.id);
          const { data: lessonsData } = await supabase
            .from("lessons")
            .select("*")
            .in("trainer_id", trainerIds)
            .order("title");
          
          setLessons(lessonsData || []);
        }
      }
      setLoading(false);
    }
    loadData();
  }, [user]);

  const resetForm = () => {
    setFormTrainerId(trainers.length > 0 ? trainers[0].id : "");
    setFormTitle("");
    setFormDescription("");
    setFormDuration(60);
    setFormPrice(0);
    setFormMaxParticipants(1);
    setFormLocation("");
    setFormIsActive(true);
    setFormPaymentTiming("upfront");
    setEditingLesson(null);
  };

  const openEditDialog = (lesson: Lesson) => {
    setEditingLesson(lesson);
    setFormTrainerId(lesson.trainer_id);
    setFormTitle(lesson.title);
    setFormDescription(lesson.description || "");
    setFormDuration(lesson.duration_minutes);
    setFormPrice(lesson.price);
    setFormMaxParticipants(lesson.max_participants);
    setFormLocation(lesson.location || "");
    setFormIsActive(lesson.is_active);
    setFormPaymentTiming(lesson.payment_timing as "upfront" | "after");
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!formTrainerId || !formTitle) {
      toast({
        title: t("lessons.error", "Error"),
        description: t("lessons.requiredFields", "Please fill in all required fields"),
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const lessonData = {
        trainer_id: formTrainerId,
        title: formTitle,
        description: formDescription || null,
        duration_minutes: formDuration,
        price: formPrice,
        max_participants: formMaxParticipants,
        location: formLocation || null,
        is_active: formIsActive,
        payment_timing: formPaymentTiming,
      };

      if (editingLesson) {
        const { error } = await supabase
          .from("lessons")
          .update(lessonData)
          .eq("id", editingLesson.id);
        
        if (error) throw error;
        
        setLessons(prev => prev.map(l => l.id === editingLesson.id ? { ...l, ...lessonData } : l));
        toast({ title: t("lessons.updated", "Lesson Updated") });
      } else {
        const { data, error } = await supabase
          .from("lessons")
          .insert(lessonData)
          .select()
          .single();
        
        if (error) throw error;
        
        setLessons(prev => [...prev, data]);
        toast({ title: t("lessons.created", "Lesson Created") });
      }
      
      setDialogOpen(false);
      resetForm();
    } catch (error: any) {
      toast({
        title: t("lessons.error", "Error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!lessonToDelete) return;
    
    try {
      const { error } = await supabase
        .from("lessons")
        .delete()
        .eq("id", lessonToDelete.id);
      
      if (error) throw error;
      
      setLessons(prev => prev.filter(l => l.id !== lessonToDelete.id));
      toast({ title: t("lessons.deleted", "Lesson Deleted") });
    } catch (error: any) {
      toast({
        title: t("lessons.error", "Error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setDeleteDialogOpen(false);
      setLessonToDelete(null);
    }
  };

  const handleDuplicate = (lesson: Lesson) => {
    setEditingLesson(null);
    setFormTrainerId(lesson.trainer_id);
    setFormTitle(`${lesson.title} (${t("lessons.copy", "Copy")})`);
    setFormDescription(lesson.description || "");
    setFormDuration(lesson.duration_minutes);
    setFormPrice(lesson.price);
    setFormMaxParticipants(lesson.max_participants);
    setFormLocation(lesson.location || "");
    setFormIsActive(lesson.is_active);
    setFormPaymentTiming(lesson.payment_timing as "upfront" | "after");
    setDialogOpen(true);
  };

  const filteredLessons = selectedTrainerId === "all" 
    ? lessons 
    : lessons.filter(l => l.trainer_id === selectedTrainerId);

  const getTrainerName = (trainerId: string) => {
    return trainers.find(t => t.id === trainerId)?.name || "Unknown";
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-8">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-[500px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold">{clubName} - {t("lessons.title", "Lessons")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("lessons.description", "Create and manage lessons for your trainers")}
          </p>
        </div>
        <ClubNavigation />
      </div>

      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>{t("lessons.manageLessons", "Manage Lessons")}</CardTitle>
              <CardDescription>
                {t("lessons.lessonsCount", "{{count}} lessons", { count: filteredLessons.length })}
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <Select value={selectedTrainerId} onValueChange={setSelectedTrainerId}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={t("lessons.allTrainers", "All Trainers")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("lessons.allTrainers", "All Trainers")}</SelectItem>
                  {trainers.map(trainer => (
                    <SelectItem key={trainer.id} value={trainer.id}>
                      {trainer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => { resetForm(); setDialogOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                {t("lessons.addLesson", "Add Lesson")}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {trainers.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t("lessons.noTrainers", "No trainers in your club yet")}</p>
                <p className="text-sm mt-2">{t("lessons.addTrainersFirst", "Add trainers to your club to create lessons for them")}</p>
              </div>
            ) : filteredLessons.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{t("lessons.noLessons", "No lessons created yet")}</p>
                <Button 
                  variant="outline" 
                  className="mt-4"
                  onClick={() => { resetForm(); setDialogOpen(true); }}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {t("lessons.createFirst", "Create First Lesson")}
                </Button>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredLessons.map(lesson => (
                  <Card key={lesson.id} className="relative">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-base">{lesson.title}</CardTitle>
                          <p className="text-sm text-muted-foreground">{getTrainerName(lesson.trainer_id)}</p>
                        </div>
                        <Badge variant={lesson.is_active ? "default" : "secondary"}>
                          {lesson.is_active ? tTrainer("lessons.active") : tTrainer("lessons.inactive")}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {lesson.description && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{lesson.description}</p>
                      )}
                      <div className="flex flex-wrap gap-2 text-xs">
                        <Badge variant="outline">{lesson.duration_minutes} min</Badge>
                        <Badge variant="outline">€{lesson.price}</Badge>
                        <Badge variant="outline">{lesson.max_participants} {t("lessons.participants", "participants")}</Badge>
                      </div>
                      {lesson.location && (
                        <p className="text-xs text-muted-foreground">{lesson.location}</p>
                      )}
                      <div className="flex items-center gap-2 pt-2">
                        <Button variant="ghost" size="sm" onClick={() => openEditDialog(lesson)}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDuplicate(lesson)}>
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-destructive hover:text-destructive"
                          onClick={() => { setLessonToDelete(lesson); setDeleteDialogOpen(true); }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingLesson ? t("lessons.editLesson", "Edit Lesson") : t("lessons.addLesson", "Add Lesson")}
            </DialogTitle>
            <DialogDescription>
              {t("lessons.lessonFormDescription", "Configure the lesson details")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-4">
            {/* Trainer Selection */}
            <div className="space-y-2">
              <Label>{t("lessons.selectTrainer", "Trainer")} *</Label>
              <Select value={formTrainerId} onValueChange={setFormTrainerId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("lessons.selectTrainerPlaceholder", "Select a trainer")} />
                </SelectTrigger>
                <SelectContent>
                  {trainers.map(trainer => (
                    <SelectItem key={trainer.id} value={trainer.id}>
                      {trainer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Title */}
            <div className="space-y-2">
              <Label>{tTrainer("lessons.title")} *</Label>
              <Input 
                value={formTitle} 
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder={tTrainer("lessons.titlePlaceholder")}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label>{tTrainer("lessons.description")}</Label>
              <Textarea 
                value={formDescription} 
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder={tTrainer("lessons.descriptionPlaceholder")}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Duration */}
              <div className="space-y-2">
                <Label>{tTrainer("lessons.duration")}</Label>
                <Select value={formDuration.toString()} onValueChange={(v) => setFormDuration(parseInt(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 min</SelectItem>
                    <SelectItem value="45">45 min</SelectItem>
                    <SelectItem value="60">60 min</SelectItem>
                    <SelectItem value="90">90 min</SelectItem>
                    <SelectItem value="120">120 min</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Price */}
              <div className="space-y-2">
                <Label>{tTrainer("lessons.price")} (€)</Label>
                <Input 
                  type="number" 
                  value={formPrice} 
                  onChange={(e) => setFormPrice(parseFloat(e.target.value) || 0)}
                  min={0}
                  step={0.01}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Max Participants */}
              <div className="space-y-2">
                <Label>{tTrainer("lessons.maxParticipants")}</Label>
                <Input 
                  type="number" 
                  value={formMaxParticipants} 
                  onChange={(e) => setFormMaxParticipants(parseInt(e.target.value) || 1)}
                  min={1}
                  max={20}
                />
              </div>

              {/* Payment Timing */}
              <div className="space-y-2">
                <Label>{tTrainer("lessons.paymentTiming")}</Label>
                <Select value={formPaymentTiming} onValueChange={(v: "upfront" | "after") => setFormPaymentTiming(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="upfront">{tTrainer("lessons.upfront")}</SelectItem>
                    <SelectItem value="after">{tTrainer("lessons.after")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Location */}
            <div className="space-y-2">
              <Label>{tTrainer("lessons.location")}</Label>
              <Input 
                value={formLocation} 
                onChange={(e) => setFormLocation(e.target.value)}
                placeholder={tTrainer("lessons.locationPlaceholder")}
              />
            </div>

            {/* Active Toggle */}
            <div className="flex items-center justify-between">
              <Label>{tTrainer("lessons.isActive")}</Label>
              <Switch checked={formIsActive} onCheckedChange={setFormIsActive} />
            </div>

            <Button onClick={handleSubmit} disabled={isSaving} className="w-full">
              {isSaving ? t("common.saving", "Saving...") : editingLesson ? t("common.save", "Save Changes") : t("lessons.create", "Create Lesson")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("lessons.deleteConfirm", "Delete Lesson?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("lessons.deleteConfirmDescription", "This will permanently delete this lesson. This action cannot be undone.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t("lessons.delete", "Delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
