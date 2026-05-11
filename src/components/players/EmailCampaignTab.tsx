import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { SafeHtml } from '@/components/ui/SafeHtml';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Send, Save, FileText, History, Loader2, Users, Eye,
  Trash2, Pencil, X, Plus, FlaskConical,
} from 'lucide-react';
import { format } from 'date-fns';
import { getDateFnsLocale } from '@/lib/dateFnsLocale';
import { MiniRichTextEditor } from '@/components/ui/mini-rich-text-editor';

interface EmailCampaignTabProps {
  /** Owner: pass either academyId OR trainerId (one required). */
  academyId?: string;
  trainerId?: string;
  trainers: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  tags?: { id: string; name: string; color: string }[];
  players: {
    id: string;
    full_name: string;
    email: string;
    skill_rating: number | null;
    trainer_id?: string;
    trainer_ids?: string[];
    location_names?: string[];
    has_active_cyclus?: boolean;
    type: 'guest' | 'registered';
    tag_ids?: string[];
  }[];
}

interface CampaignTemplate {
  id: string;
  name: string;
  subject: string;
  body_html: string;
  created_at: string;
}

interface Campaign {
  id: string;
  subject: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  sent_at: string | null;
  created_at: string;
  filters: any;
}

function getLevelBand(rating: number | null): string {
  if (rating === null) return 'unrated';
  if (rating <= 3) return 'beginner';
  if (rating <= 6) return 'intermediate';
  if (rating <= 9) return 'advanced';
  return 'pro';
}

export function EmailCampaignTab({ academyId, trainerId, trainers, locations, tags = [], players }: EmailCampaignTabProps) {
  const ownerCol = academyId ? 'academy_profile_id' : 'trainer_profile_id';
  const ownerId = academyId ?? trainerId;
  const { t, i18n } = useTranslation('trainer');
  const dateLocale = getDateFnsLocale(i18n.language);
  const { toast } = useToast();
  const [activeView, setActiveView] = useState('compose');

  // Compose state
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [filterTrainer, setFilterTrainer] = useState('all');
  const [filterLocation, setFilterLocation] = useState('all');
  const [filterLevel, setFilterLevel] = useState('all');
  const [filterWaitingList, setFilterWaitingList] = useState('all');
  const [filterCyclus, setFilterCyclus] = useState('all');
  const [filterTag, setFilterTag] = useState('all');

  // Templates
  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  // History
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  // Sending
  const [isSending, setIsSending] = useState(false);
  const [showConfirmSend, setShowConfirmSend] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Draft management
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [confirmDeleteDraftId, setConfirmDeleteDraftId] = useState<string | null>(null);

  // Manual recipient management
  const [recipients, setRecipients] = useState<{ id: string; full_name: string; email: string; isManual?: boolean }[]>([]);
  const [addEmail, setAddEmail] = useState('');
  const [addName, setAddName] = useState('');

  // Test email
  const [testEmail, setTestEmail] = useState('');
  const [isSendingTest, setIsSendingTest] = useState(false);

  useEffect(() => {
    if (!ownerId) return;
    fetchTemplates();
    fetchCampaigns();
  }, [ownerId]);

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const { data } = await supabase
        .from('email_campaign_templates')
        .select('*')
        .eq(ownerCol, ownerId!)
        .order('created_at', { ascending: false });
      setTemplates(data || []);
    } catch (err) {
      logger.error('Error fetching templates', err as Error);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const fetchCampaigns = async () => {
    setLoadingCampaigns(true);
    try {
      const { data } = await supabase
        .from('email_campaigns')
        .select('*')
        .eq(ownerCol, ownerId!)
        .order('created_at', { ascending: false });
      setCampaigns(data || []);
    } catch (err) {
      logger.error('Error fetching campaigns', err as Error);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  // Filter players
  const filteredRecipients = players.filter((p) => {
    if (!p.email) return false;
    if (filterTrainer !== 'all' && !p.trainer_ids?.includes(filterTrainer)) return false;
    if (filterLocation !== 'all' && !p.location_names?.includes(filterLocation)) return false;
    if (filterLevel !== 'all' && getLevelBand(p.skill_rating) !== filterLevel) return false;
    if (filterCyclus === 'yes' && !p.has_active_cyclus) return false;
    if (filterCyclus === 'no' && p.has_active_cyclus) return false;
    if (filterTag !== 'all') {
      if (filterTag === 'untagged') {
        if (p.tag_ids && p.tag_ids.length > 0) return false;
      } else {
        if (!p.tag_ids?.includes(filterTag)) return false;
      }
    }
    return true;
  });

  // Sync recipients when filters change (skipped while loading a draft)
  const skipNextRecipientSync = useRef(false);
  useEffect(() => {
    if (skipNextRecipientSync.current) {
      skipNextRecipientSync.current = false;
      return;
    }
    setRecipients(filteredRecipients.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email })));
  }, [filterTrainer, filterLocation, filterLevel, filterCyclus, filterTag, players]);

  const handleRemoveRecipient = (id: string) => {
    setRecipients((prev) => prev.filter((r) => r.id !== id));
  };

  const handleAddManualRecipient = () => {
    if (!addEmail.trim()) return;
    const newR = { id: `manual-${Date.now()}`, full_name: addName.trim() || addEmail.trim(), email: addEmail.trim(), isManual: true };
    setRecipients((prev) => [...prev, newR]);
    setAddEmail('');
    setAddName('');
  };

  const handleSendTestEmail = async () => {
    if (!testEmail.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast({ title: t('emailCampaign.toasts.missingFields'), description: t('emailCampaign.toasts.missingTestDesc'), variant: 'destructive' });
      return;
    }
    setIsSendingTest(true);
    try {
      const { error } = await supabase.functions.invoke('send-campaign-emails', {
        body: { testMode: true, testEmail: testEmail.trim(), subject: subject.trim(), bodyHtml, academyProfileId: academyId, trainerProfileId: trainerId },
      });
      if (error) throw error;
      toast({ title: t('emailCampaign.toasts.testSent'), description: t('emailCampaign.toasts.testSentDesc', { email: testEmail.trim() }) });
    } catch (err: any) {
      logger.error('Error sending test email', err);
      toast({ title: t('emailCampaign.toasts.error'), description: err.message || t('emailCampaign.toasts.testError'), variant: 'destructive' });
    } finally {
      setIsSendingTest(false);
    }
  };

  const handleSaveTemplate = async () => {
    if (!templateName.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast({ title: t('emailCampaign.toasts.missingFields'), description: t('emailCampaign.toasts.missingTemplateDesc'), variant: 'destructive' });
      return;
    }

    try {
      if (editingTemplateId) {
        await supabase
          .from('email_campaign_templates')
          .update({ name: templateName.trim(), subject: subject.trim(), body_html: bodyHtml })
          .eq('id', editingTemplateId);
        toast({ title: t('emailCampaign.toasts.templateUpdated') });
      } else {
        await supabase
          .from('email_campaign_templates')
          .insert({
            [ownerCol]: ownerId,
            name: templateName.trim(),
            subject: subject.trim(),
            body_html: bodyHtml,
          } as any);
        toast({ title: t('emailCampaign.toasts.templateSaved') });
      }
      setEditingTemplateId(null);
      setTemplateName('');
      fetchTemplates();
    } catch (err) {
      logger.error('Error saving template', err as Error);
      toast({ title: t('emailCampaign.toasts.error'), description: t('emailCampaign.toasts.templateError'), variant: 'destructive' });
    }
  };

  const handleLoadTemplate = (template: CampaignTemplate) => {
    setSubject(template.subject);
    setBodyHtml(template.body_html);
    setTemplateName(template.name);
    setEditingTemplateId(template.id);
    setActiveView('compose');
    toast({ title: t('emailCampaign.toasts.templateLoaded'), description: template.name });
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await supabase.from('email_campaign_templates').delete().eq('id', id);
      toast({ title: t('emailCampaign.toasts.templateDeleted') });
      fetchTemplates();
    } catch (err) {
      logger.error('Error deleting template', err as Error);
    }
  };

  const handleSendCampaign = async () => {
    setShowConfirmSend(false);
    setIsSending(true);

    try {
      const filters = { trainer: filterTrainer, location: filterLocation, level: filterLevel, cyclus: filterCyclus, tag: filterTag };
      let campaignId = currentDraftId;

      if (campaignId) {
        // Update existing draft
        const { error: updErr } = await supabase
          .from('email_campaigns')
          .update({
            subject: subject.trim(),
            body_html: bodyHtml,
            filters,
            total_recipients: recipients.length,
          } as any)
          .eq('id', campaignId);
        if (updErr) throw updErr;
        // Replace recipient rows
        await supabase.from('email_campaign_recipients').delete().eq('campaign_id', campaignId);
      } else {
        const { data: campaign, error: campErr } = await supabase
          .from('email_campaigns')
          .insert({
            [ownerCol]: ownerId,
            subject: subject.trim(),
            body_html: bodyHtml,
            filters,
            status: 'draft',
            total_recipients: recipients.length,
          } as any)
          .select()
          .single();

        if (campErr || !campaign) throw campErr || new Error('Could not create campaign');
        campaignId = campaign.id;
      }

      // Insert recipients
      const recipientRows = recipients.map((p) => ({
        campaign_id: campaignId,
        recipient_email: p.email,
        recipient_name: p.full_name,
        status: 'pending',
      }));

      const { error: recErr } = await supabase
        .from('email_campaign_recipients')
        .insert(recipientRows as any);

      if (recErr) throw recErr;

      // Invoke edge function
      const { error: fnErr } = await supabase.functions.invoke('send-campaign-emails', {
        body: { campaignId },
      });

      if (fnErr) throw fnErr;

      toast({
        title: t('emailCampaign.toasts.campaignSent'),
        description: t('emailCampaign.toasts.campaignSentDesc', { count: recipients.length }),
      });

      // Reset
      setSubject('');
      setBodyHtml('');
      setTemplateName('');
      setEditingTemplateId(null);
      setCurrentDraftId(null);
      fetchCampaigns();
    } catch (err: any) {
      logger.error('Error sending campaign', err);
      toast({ title: t('emailCampaign.toasts.error'), description: err.message || t('emailCampaign.toasts.campaignError'), variant: 'destructive' });
    } finally {
      setIsSending(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!subject.trim() && !bodyHtml.trim()) return;
    setIsSavingDraft(true);
    try {
      const filters = { trainer: filterTrainer, location: filterLocation, level: filterLevel, cyclus: filterCyclus, tag: filterTag };
      let draftId = currentDraftId;

      if (draftId) {
        const { error } = await supabase
          .from('email_campaigns')
          .update({
            subject: subject.trim(),
            body_html: bodyHtml,
            filters,
            total_recipients: recipients.length,
          } as any)
          .eq('id', draftId);
        if (error) throw error;
        await supabase.from('email_campaign_recipients').delete().eq('campaign_id', draftId);
      } else {
        const { data, error } = await supabase
          .from('email_campaigns')
          .insert({
            [ownerCol]: ownerId,
            subject: subject.trim(),
            body_html: bodyHtml,
            filters,
            status: 'draft',
            total_recipients: recipients.length,
          } as any)
          .select()
          .single();
        if (error || !data) throw error || new Error('Could not save draft');
        draftId = data.id;
        setCurrentDraftId(draftId);
      }

      if (recipients.length > 0) {
        const rows = recipients.map((p) => ({
          campaign_id: draftId,
          recipient_email: p.email,
          recipient_name: p.full_name,
          status: 'pending',
        }));
        const { error: recErr } = await supabase
          .from('email_campaign_recipients')
          .insert(rows as any);
        if (recErr) throw recErr;
      }

      toast({
        title: t('emailCampaign.toasts.draftSaved'),
        description: t('emailCampaign.toasts.draftSavedDesc'),
      });
      fetchCampaigns();
    } catch (err: any) {
      logger.error('Error saving draft', err);
      toast({ title: t('emailCampaign.toasts.error'), description: err.message || t('emailCampaign.toasts.draftError'), variant: 'destructive' });
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleLoadDraft = async (campaign: Campaign) => {
    try {
      const { data: rec } = await supabase
        .from('email_campaign_recipients')
        .select('recipient_email, recipient_name')
        .eq('campaign_id', campaign.id);

      // Fetch full campaign including body_html
      const { data: full } = await supabase
        .from('email_campaigns')
        .select('*')
        .eq('id', campaign.id)
        .single();

      if (!full) return;

      const f = (full as any).filters || {};
      skipNextRecipientSync.current = true;
      setFilterTrainer(f.trainer ?? 'all');
      setFilterLocation(f.location ?? 'all');
      setFilterLevel(f.level ?? 'all');
      setFilterCyclus(f.cyclus ?? 'all');
      setFilterTag(f.tag ?? 'all');
      setSubject((full as any).subject || '');
      setBodyHtml((full as any).body_html || '');
      setRecipients(
        (rec || []).map((r, i) => ({
          id: `draft-${i}`,
          full_name: (r as any).recipient_name || (r as any).recipient_email,
          email: (r as any).recipient_email,
        }))
      );
      setCurrentDraftId(campaign.id);
      setActiveView('compose');
      toast({ title: t('emailCampaign.toasts.draftLoaded') });
    } catch (err) {
      logger.error('Error loading draft', err as Error);
    }
  };

  const handleDeleteDraft = async (id: string) => {
    setConfirmDeleteDraftId(null);
    try {
      await supabase.from('email_campaign_recipients').delete().eq('campaign_id', id);
      await supabase.from('email_campaigns').delete().eq('id', id);
      if (currentDraftId === id) setCurrentDraftId(null);
      toast({ title: t('emailCampaign.toasts.draftDeleted') });
      fetchCampaigns();
    } catch (err) {
      logger.error('Error deleting draft', err as Error);
    }
  };

  const handleDiscardDraftEdit = () => {
    setCurrentDraftId(null);
    setSubject('');
    setBodyHtml('');
    setTemplateName('');
    setEditingTemplateId(null);
  };


  const subjectInputRef = useRef<HTMLInputElement | null>(null);

  const insertVariable = (variable: string) => {
    document.execCommand('insertText', false, `{{${variable}}}`);
  };

  const insertSubjectVariable = (variable: string) => {
    const token = `{{${variable}}}`;
    const el = subjectInputRef.current;
    if (!el) {
      setSubject((s) => s + token);
      return;
    }
    const start = el.selectionStart ?? subject.length;
    const end = el.selectionEnd ?? subject.length;
    const next = subject.slice(0, start) + token + subject.slice(end);
    setSubject(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const applyPreviewVars = (s: string) =>
    s
      .replace(/\{\{first_name\}\}/gi, 'Jan')
      .replace(/\{\{name\}\}/gi, 'Jan de Vries');

  const getPreviewHtml = () => applyPreviewVars(bodyHtml);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sent': return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">{t('emailCampaign.status.sent')}</Badge>;
      case 'sending': return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{t('emailCampaign.status.sending')}</Badge>;
      case 'draft': return <Badge variant="secondary">{t('emailCampaign.status.draft')}</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      <Tabs value={activeView} onValueChange={setActiveView}>
        <TabsList>
          <TabsTrigger value="compose" className="gap-1.5">
            <Send className="h-3.5 w-3.5" /> {t('emailCampaign.tabs.compose')}
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" /> {t('emailCampaign.tabs.templates')}
            {templates.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs">{templates.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> {t('emailCampaign.tabs.history')}
            {campaigns.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs">{campaigns.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Compose View */}
        <TabsContent value="compose" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Recipients panel */}
            <Card className="lg:col-span-1">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4" /> {t('emailCampaign.recipients.title')}
                </CardTitle>
                <CardDescription>
                  {t('emailCampaign.recipients.description')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('emailCampaign.recipients.trainer')}</Label>
                  <Select value={filterTrainer} onValueChange={setFilterTrainer}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('emailCampaign.recipients.allTrainers')}</SelectItem>
                      {trainers.map((tr) => (
                        <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('emailCampaign.recipients.location')}</Label>
                  <Select value={filterLocation} onValueChange={setFilterLocation}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('emailCampaign.recipients.allLocations')}</SelectItem>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.name}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('emailCampaign.recipients.level')}</Label>
                  <Select value={filterLevel} onValueChange={setFilterLevel}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('emailCampaign.recipients.allLevels')}</SelectItem>
                      <SelectItem value="beginner">{t('emailCampaign.recipients.beginner')}</SelectItem>
                      <SelectItem value="intermediate">{t('emailCampaign.recipients.intermediate')}</SelectItem>
                      <SelectItem value="advanced">{t('emailCampaign.recipients.advanced')}</SelectItem>
                      <SelectItem value="pro">{t('emailCampaign.recipients.pro')}</SelectItem>
                      <SelectItem value="unrated">{t('emailCampaign.recipients.unrated')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('emailCampaign.recipients.activeCyclus')}</Label>
                  <Select value={filterCyclus} onValueChange={setFilterCyclus}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('emailCampaign.recipients.all')}</SelectItem>
                      <SelectItem value="yes">{t('emailCampaign.recipients.yes')}</SelectItem>
                      <SelectItem value="no">{t('emailCampaign.recipients.no')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('emailCampaign.recipients.tag', 'Tag')}</Label>
                  <Select value={filterTag} onValueChange={setFilterTag}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('emailCampaign.recipients.allTags', 'All tags')}</SelectItem>
                      <SelectItem value="untagged">{t('emailCampaign.recipients.untagged', 'Untagged')}</SelectItem>
                      {tags.map((tag) => (
                        <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <div className="flex items-center justify-between py-2">
                  <span className="text-sm font-medium">{t('emailCampaign.recipients.selected')}</span>
                  <Badge variant="secondary" className="text-sm">
                    {recipients.length}
                  </Badge>
                </div>

                {recipients.length > 0 && (
                  <div className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
                    {recipients.slice(0, 50).map((p) => (
                      <div key={p.id} className="text-xs flex justify-between items-center py-0.5 group">
                        <span className="truncate flex-1">{p.full_name}</span>
                        <span className="text-muted-foreground truncate ml-2 max-w-[100px]">{p.email}</span>
                        <Button
                          variant="ghost"
                          size="icon" aria-label="Close"
                          className="h-5 w-5 ml-1 opacity-0 group-hover:opacity-100 shrink-0"
                          onClick={() => handleRemoveRecipient(p.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                    {recipients.length > 50 && (
                      <p className="text-xs text-muted-foreground text-center pt-1">
                        {t('emailCampaign.recipients.moreCount', { count: recipients.length - 50 })}
                      </p>
                    )}
                  </div>
                )}

                {/* Add manual recipient */}
                <div className="flex items-center gap-1.5">
                  <Input
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder={t('emailCampaign.recipients.addName')}
                    className="h-7 text-xs flex-1"
                  />
                  <Input
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder={t('emailCampaign.recipients.addEmail')}
                    className="h-7 text-xs flex-1"
                    onKeyDown={(e) => e.key === 'Enter' && handleAddManualRecipient()}
                  />
                  <Button
                    variant="outline"
                    size="icon" aria-label="Add"
                    className="h-7 w-7 shrink-0"
                    onClick={handleAddManualRecipient}
                    disabled={!addEmail.trim()}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {recipients.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {t('emailCampaign.recipients.noMatch')}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Email composer panel */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{t('emailCampaign.compose.title')}</CardTitle>
                    <CardDescription>
                      <Trans
                        i18nKey="emailCampaign.compose.descriptionHtml"
                        t={t}
                        values={{ var: '{{first_name}}' }}
                        components={{ code: <code className="text-xs bg-muted px-1 py-0.5 rounded" /> }}
                      />
                    </CardDescription>
                  </div>
                  {currentDraftId && (
                    <Badge variant="secondary" className="gap-1.5 shrink-0">
                      <FileText className="h-3 w-3" />
                      {t('emailCampaign.compose.editingDraft')}
                      <button
                        type="button"
                        onClick={handleDiscardDraftEdit}
                        className="ml-1 hover:text-foreground"
                        aria-label={t('emailCampaign.compose.discardDraftChanges')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="campaign-subject">{t('emailCampaign.compose.subject')}</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => insertSubjectVariable('first_name')}
                    >
                      {t('emailCampaign.compose.insertName', { name: '{{first_name}}' })}
                    </Button>
                  </div>
                  <Input
                    id="campaign-subject"
                    ref={subjectInputRef}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder={t('emailCampaign.compose.subjectPlaceholder')}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>{t('emailCampaign.compose.body')}</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => insertVariable('first_name')}
                    >
                      {t('emailCampaign.compose.insertName', { name: '{{first_name}}' })}
                    </Button>
                  </div>
                  <MiniRichTextEditor
                    value={bodyHtml}
                    onChange={setBodyHtml}
                    placeholder={t('emailCampaign.compose.bodyPlaceholder')}
                    minHeight="320px"
                    allowHtmlView
                  />
                </div>

                {/* Save template row */}
                <div className="flex items-center gap-2">
                  <Input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder={t('emailCampaign.compose.templateNamePlaceholder')}
                    className="max-w-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleSaveTemplate}
                    disabled={!templateName.trim() || !subject.trim()}
                  >
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    {editingTemplateId ? t('emailCampaign.compose.updateTemplate') : t('emailCampaign.compose.saveAsTemplate')}
                  </Button>
                </div>

                <Separator />

                <div className="flex flex-col gap-3">
                  {/* Test email row — always visible, recipient editable each time */}
                  <div className="flex items-center gap-1.5 flex-wrap rounded-md border bg-muted/30 px-2 py-1.5">
                    <FlaskConical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground shrink-0">
                      {t('emailCampaign.compose.sendTest')}:
                    </span>
                    <Input
                      type="email"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      placeholder={t('emailCampaign.compose.testEmailPlaceholder')}
                      className="h-8 flex-1 min-w-[180px] text-sm"
                      onKeyDown={(e) => e.key === 'Enter' && handleSendTestEmail()}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSendTestEmail}
                      disabled={isSendingTest || !testEmail.trim() || !subject.trim() || !bodyHtml.trim()}
                    >
                      {isSendingTest ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {t('emailCampaign.compose.sendTest')}
                    </Button>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowPreview(true)}
                      disabled={!bodyHtml.trim()}
                    >
                      <Eye className="mr-1.5 h-4 w-4" /> {t('emailCampaign.compose.preview')}
                    </Button>

                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleSaveDraft}
                        disabled={isSavingDraft || (!subject.trim() && !bodyHtml.trim())}
                      >
                        {isSavingDraft ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <FileText className="mr-1.5 h-4 w-4" />
                        )}
                        {t('emailCampaign.compose.saveDraft')}
                      </Button>
                      <Button
                        onClick={() => setShowConfirmSend(true)}
                        disabled={isSending || !subject.trim() || !bodyHtml.trim() || recipients.length === 0}
                      >
                        {isSending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="mr-2 h-4 w-4" />
                        )}
                        {t('emailCampaign.compose.sendToCount', { count: recipients.length })}
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Templates View */}
        <TabsContent value="templates" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('emailCampaign.templates.title')}</CardTitle>
              <CardDescription>{t('emailCampaign.templates.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingTemplates ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : templates.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  {t('emailCampaign.templates.empty')}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('emailCampaign.templates.name')}</TableHead>
                      <TableHead>{t('emailCampaign.templates.subject')}</TableHead>
                      <TableHead>{t('emailCampaign.templates.created')}</TableHead>
                      <TableHead className="w-[100px]">{t('emailCampaign.templates.actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates.map((tmpl) => (
                      <TableRow key={tmpl.id} className="cursor-pointer" onClick={() => handleLoadTemplate(tmpl)}>
                        <TableCell className="font-medium">{tmpl.name}</TableCell>
                        <TableCell className="text-muted-foreground">{tmpl.subject}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {format(new Date(tmpl.created_at), 'dd MMM yyyy', { locale: dateLocale })}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon" aria-label="Edit"
                              className="h-7 w-7"
                              onClick={(e) => { e.stopPropagation(); handleLoadTemplate(tmpl); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon" aria-label="Delete"
                              className="h-7 w-7 text-destructive"
                              onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(tmpl.id); }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* History View */}
        <TabsContent value="history" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('emailCampaign.history.title')}</CardTitle>
              <CardDescription>{t('emailCampaign.history.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {loadingCampaigns ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : campaigns.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  {t('emailCampaign.history.empty')}
                </p>
              ) : (
                <>
                  {/* Drafts */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-muted-foreground">
                      {t('emailCampaign.history.draftsTitle')}
                    </h3>
                    {campaigns.filter((c) => c.status === 'draft').length === 0 ? (
                      <p className="text-sm text-muted-foreground py-3">
                        {t('emailCampaign.history.noDrafts')}
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('emailCampaign.history.subject')}</TableHead>
                            <TableHead>{t('emailCampaign.history.recipients')}</TableHead>
                            <TableHead>{t('emailCampaign.history.date')}</TableHead>
                            <TableHead className="w-[100px]">{t('emailCampaign.history.actions')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {campaigns
                            .filter((c) => c.status === 'draft')
                            .map((c) => (
                              <TableRow
                                key={c.id}
                                className="cursor-pointer"
                                onClick={() => handleLoadDraft(c)}
                              >
                                <TableCell className="font-medium max-w-[280px] truncate">
                                  {c.subject || <span className="text-muted-foreground italic">{t('emailCampaign.compose.subjectPlaceholder')}</span>}
                                </TableCell>
                                <TableCell>{c.total_recipients}</TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                  {format(new Date(c.created_at), 'dd MMM yyyy HH:mm', { locale: dateLocale })}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7"
                                      aria-label={t('emailCampaign.history.openDraft')}
                                      onClick={(e) => { e.stopPropagation(); handleLoadDraft(c); }}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-destructive"
                                      aria-label={t('emailCampaign.history.deleteDraft')}
                                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteDraftId(c.id); }}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>

                  {/* Sent */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-muted-foreground">
                      {t('emailCampaign.history.sentTitle')}
                    </h3>
                    {campaigns.filter((c) => c.status !== 'draft').length === 0 ? (
                      <p className="text-sm text-muted-foreground py-3">
                        {t('emailCampaign.history.empty')}
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('emailCampaign.history.subject')}</TableHead>
                            <TableHead>{t('emailCampaign.history.status')}</TableHead>
                            <TableHead>{t('emailCampaign.history.recipients')}</TableHead>
                            <TableHead>{t('emailCampaign.history.sentFailed')}</TableHead>
                            <TableHead>{t('emailCampaign.history.date')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {campaigns
                            .filter((c) => c.status !== 'draft')
                            .map((c) => (
                              <TableRow key={c.id}>
                                <TableCell className="font-medium max-w-[200px] truncate">{c.subject}</TableCell>
                                <TableCell>{getStatusBadge(c.status)}</TableCell>
                                <TableCell>{c.total_recipients}</TableCell>
                                <TableCell>
                                  <span className="text-green-600">{c.sent_count}</span>
                                  {c.failed_count > 0 && (
                                    <span className="text-destructive ml-1">/ {t('emailCampaign.history.failed', { count: c.failed_count })}</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">
                                  {c.sent_at ? format(new Date(c.sent_at), 'dd MMM yyyy HH:mm', { locale: dateLocale }) : '—'}
                                </TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Confirm Send Dialog */}
      <AlertDialog open={showConfirmSend} onOpenChange={setShowConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('emailCampaign.confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="emailCampaign.confirm.description"
                t={t}
                count={recipients.length}
                values={{ count: recipients.length, subject }}
                components={[<strong />, <strong />, <strong />, <strong />]}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('emailCampaign.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSendCampaign}>
              <Send className="mr-2 h-4 w-4" /> {t('emailCampaign.confirm.sendNow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview Dialog */}
      <AlertDialog open={showPreview} onOpenChange={setShowPreview}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('emailCampaign.previewDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('emailCampaign.previewDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="border rounded-md p-4 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground">{t('emailCampaign.previewDialog.subjectLabel')}</p>
              <p className="font-medium">{applyPreviewVars(subject)}</p>
            </div>
            <Separator />
            <SafeHtml
              html={getPreviewHtml()}
              className="prose prose-sm max-w-none"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('emailCampaign.previewDialog.close')}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm delete draft */}
      <AlertDialog open={!!confirmDeleteDraftId} onOpenChange={(o) => !o && setConfirmDeleteDraftId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('emailCampaign.history.deleteDraft')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('emailCampaign.history.confirmDeleteDraft')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('emailCampaign.confirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteDraftId && handleDeleteDraft(confirmDeleteDraftId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Trash2 className="mr-2 h-4 w-4" /> {t('emailCampaign.history.deleteDraft')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
