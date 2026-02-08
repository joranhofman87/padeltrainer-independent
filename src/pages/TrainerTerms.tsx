import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText, Building2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/lib/supabaseClient';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';

export default function TrainerTerms() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [academyTerms, setAcademyTerms] = useState<{ terms: string; academyName: string } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      Underline,
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none min-h-[200px] p-4 focus:outline-none',
      },
    },
  });

  useEffect(() => {
    if (!user) return;

    const fetchTerms = async () => {
      setLoading(true);
      try {
        // Get trainer profile
        const { data: trainerProfile } = await supabase
          .from('trainer_profiles')
          .select('id, general_terms')
          .eq('user_id', user.id)
          .maybeSingle();

        if (trainerProfile) {
          // Check if trainer is in an academy with terms
          const { data: academyTrainer } = await supabase
            .from('academy_trainers')
            .select('academy_profiles:academy_profile_id(general_terms, name)')
            .eq('trainer_profile_id', trainerProfile.id)
            .eq('status', 'active')
            .maybeSingle();

          if (academyTrainer) {
            const academy = academyTrainer.academy_profiles as unknown as { general_terms: string | null; name: string } | null;
            if (academy?.general_terms) {
              setAcademyTerms({ terms: academy.general_terms, academyName: academy.name });
            }
          }

          // Load trainer's own terms into editor
          if (editor && trainerProfile.general_terms) {
            editor.commands.setContent(trainerProfile.general_terms);
          }
        }
      } catch (error) {
        logger.error('Error fetching terms', error as Error, { component: 'TrainerTerms' });
      } finally {
        setLoading(false);
      }
    };

    fetchTerms();
  }, [user, editor]);

  const handleSave = async () => {
    if (!user || !editor) return;

    setSaving(true);
    try {
      const content = editor.getHTML();
      const isEmpty = editor.isEmpty;

      const { error } = await supabase
        .from('trainer_profiles')
        .update({ general_terms: isEmpty ? null : content })
        .eq('user_id', user.id);

      if (error) throw error;

      toast.success(t('terms.saved', 'Terms saved successfully'));
    } catch (error) {
      logger.error('Error saving terms', error as Error, { component: 'TrainerTerms' });
      toast.error(t('common:error', 'Something went wrong'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[400px] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app/trainer/settings')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('terms.title', 'General Terms')}</h1>
            <p className="text-sm text-muted-foreground">{t('terms.subtitle', 'Terms players must accept before booking')}</p>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-4 py-8 max-w-3xl">
        <div className="space-y-6">
          {academyTerms && (
            <Alert>
              <Building2 className="h-4 w-4" />
              <AlertDescription>
                {t('terms.academyOverride', 'Your academy ({{name}}) has set general terms. Those terms will be shown to players instead of yours when they book through the academy.', { name: academyTerms.academyName })}
              </AlertDescription>
            </Alert>
          )}

          {academyTerms && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  {t('terms.academyTerms', "{{name}}'s Terms", { name: academyTerms.academyName })}
                </CardTitle>
                <CardDescription>{t('terms.academyTermsDescription', 'These terms are shown to players booking your academy lessons.')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="prose prose-sm dark:prose-invert max-w-none p-4 border rounded-lg bg-muted/30"
                  dangerouslySetInnerHTML={{ __html: academyTerms.terms }}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {t('terms.ownTerms', 'Your General Terms')}
              </CardTitle>
              <CardDescription>
                {t('terms.ownTermsDescription', 'Write your general terms and conditions. Players must accept these before booking a lesson.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border rounded-lg overflow-hidden">
                <EditorContent editor={editor} />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {t('common:save', 'Save Changes')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  );
}
