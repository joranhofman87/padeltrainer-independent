import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plus, Edit2, Trash2, Copy, BookOpen, ArrowLeft } from "lucide-react";
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
import { getTrainerProfile } from "@/lib/auth";
import { type Lesson, createLesson, getTrainerLessons, updateLesson, deleteLesson } from "@/lib/lessons";

export default function TrainerLessons() {
  const { t } = useTranslation("trainer");
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [lessonToDelete, setLessonToDelete] = useState<Lesson | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formDuration, setFormDuration] = useState(60);
  const [formPrice, setFormPrice] = useState(0);
  const [formMaxParticipants, setFormMaxParticipants] = useState(1);
  const [formIsActive, setFormIsActive] = useState(true);
  const [formPaymentTiming, setFormPaymentTiming] = useState<"upfront" | "after">("upfront");

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/app/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function loadData() {
      if (!user) return;

      const profile = await getTrainerProfile(user.id);
      if (profile) {
        setTrainerProfileId(profile.id);
        const { data } = await getTrainerLessons(profile.id);
        setLessons((data as Lesson[]) || []);
      }
      setLoading(false);
    }
    loadData();
  }, [user]);

  const resetForm = () => {
    setFormTitle("");
    setFormDescription("");
    setFormDuration(60);
    setFormPrice(0);
    setFormMaxParticipants(1);
    setFormIsActive(true);
    setFormPaymentTiming("upfront");
    setEditingLesson(null);
  };

  const openEditDialog = (lesson: Lesson) => {
    setEditingLesson(lesson);
    setFormTitle(lesson.title);
    setFormDescription(lesson.description || "");
    setFormDuration(lesson.duration_minutes);
    setFormPrice(lesson.price);
    setFormMaxParticipants(lesson.max_participants);
    setFormIsActive(lesson.is_active);
    setFormPaymentTiming(lesson.payment_timing as "upfront" | "after");
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (!trainerProfileId || !formTitle) {
      toast({
        title: t("lessons.form.title"),
        description: t("lessons.form.titlePlaceholder"),
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const lessonData = {
        title: formTitle,
        description: formDescription || null,
        duration_minutes: formDuration,
        price: formPrice,
        max_participants: formMaxParticipants,
        location: null,
        is_active: formIsActive,
        is_recurring: false,
        recurrence_type: null,
        recurrence_day: null,
        recurrence_time: null,
        recurrence_count: null,
        recurrence_end_date: null,
        start_date: null,
        min_skill_rating: null,
        max_skill_rating: null,
        payment_timing: formPaymentTiming as "upfront" | "after",
      };

      if (editingLesson) {
        const { error } = await updateLesson(editingLesson.id, lessonData);
        if (error) throw error;
        setLessons(prev => prev.map(l => l.id === editingLesson.id ? { ...l, ...lessonData } as Lesson : l));
        toast({ title: t("lessons.form.title"), description: "Lesson updated" });
      } else {
        const { data, error } = await createLesson(trainerProfileId, lessonData);
        if (error) throw error;
        if (data) setLessons(prev => [...prev, data as Lesson]);
        toast({ title: t("lessons.createNew"), description: "Lesson created" });
      }

      setDialogOpen(false);
      resetForm();
    } catch (error: any) {
      toast({
        title: "Error",
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
      const { error } = await deleteLesson(lessonToDelete.id);
      if (error) throw error;
      setLessons(prev => prev.filter(l => l.id !== lessonToDelete.id));
      toast({ title: "Lesson deleted" });
    } catch (error: any) {
      toast({
        title: "Error",
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
    setFormTitle(`${lesson.title} (Copy)`);
    setFormDescription(lesson.description || "");
    setFormDuration(lesson.duration_minutes);
    setFormPrice(lesson.price);
    setFormMaxParticipants(lesson.max_participants);
    setFormIsActive(lesson.is_active);
    setFormPaymentTiming(lesson.payment_timing as "upfront" | "after");
    setDialogOpen(true);
  };

  if (authLoading || loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate("/trainer")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t("lessons.title")}</h1>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{t("lessons.title")}</CardTitle>
            <CardDescription>
              {lessons.length} {lessons.length === 1 ? "lesson" : "lessons"}
            </CardDescription>
          </div>
          <Button onClick={() => { resetForm(); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" />
            {t("lessons.createNew")}
          </Button>
        </CardHeader>
        <CardContent>
          {lessons.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BookOpen className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>{t("lessons.empty")}</p>
              <p className="text-sm mt-1">{t("lessons.emptyDescription")}</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => { resetForm(); setDialogOpen(true); }}
              >
                <Plus className="h-4 w-4 mr-2" />
                {t("lessons.createNew")}
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {lessons.map(lesson => (
                <Card key={lesson.id} className="relative">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base">{lesson.title}</CardTitle>
                      <Badge variant={lesson.is_active ? "default" : "secondary"}>
                        {lesson.is_active ? t("lessons.status.active") : t("lessons.status.inactive")}
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
                      <Badge variant="outline">{lesson.max_participants} max</Badge>
                    </div>
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

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingLesson ? t("lessons.form.title") : t("lessons.createNew")}
            </DialogTitle>
            <DialogDescription>
              {t("lessons.emptyDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>{t("lessons.form.title")} *</Label>
              <Input
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder={t("lessons.form.titlePlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label>{t("lessons.form.description")}</Label>
              <Textarea
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder={t("lessons.form.descriptionPlaceholder")}
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("lessons.form.duration")}</Label>
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

              <div className="space-y-2">
                <Label>{t("lessons.form.price")}</Label>
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
              <div className="space-y-2">
                <Label>{t("lessons.form.maxParticipants")}</Label>
                <Input
                  type="number"
                  value={formMaxParticipants}
                  onChange={(e) => setFormMaxParticipants(parseInt(e.target.value) || 1)}
                  min={1}
                  max={20}
                />
              </div>

              <div className="space-y-2">
                <Label>{t("lessons.form.paymentTiming")}</Label>
                <Select value={formPaymentTiming} onValueChange={(v) => setFormPaymentTiming(v as "upfront" | "after")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="upfront">{t("lessons.form.upfront")}</SelectItem>
                    <SelectItem value="after">{t("lessons.form.after")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>{t("lessons.form.active")}</Label>
                <p className="text-sm text-muted-foreground">{t("lessons.form.activeDescription")}</p>
              </div>
              <Switch checked={formIsActive} onCheckedChange={setFormIsActive} />
            </div>

            <Button onClick={handleSubmit} disabled={isSaving} className="w-full">
              {isSaving ? "..." : editingLesson ? t("lessons.form.title") : t("lessons.createNew")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Lesson?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{lessonToDelete?.title}"? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
