import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
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
  Send, Save, FileText, History, Loader2, Bold, Users, Eye,
  Trash2, Pencil, ChevronRight, X, Plus, FlaskConical,
} from 'lucide-react';
import { format } from 'date-fns';

interface EmailCampaignTabProps {
  academyId: string;
  trainers: { id: string; name: string }[];
  locations: { id: string; name: string }[];
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

export function EmailCampaignTab({ academyId, trainers, locations, players }: EmailCampaignTabProps) {
  const { t } = useTranslation('trainer');
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

  // Manual recipient management
  const [recipients, setRecipients] = useState<{ id: string; full_name: string; email: string; isManual?: boolean }[]>([]);
  const [addEmail, setAddEmail] = useState('');
  const [addName, setAddName] = useState('');

  // Test email
  const [testEmail, setTestEmail] = useState('');
  const [showTestInput, setShowTestInput] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);

  useEffect(() => {
    fetchTemplates();
    fetchCampaigns();
  }, [academyId]);

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const { data } = await supabase
        .from('email_campaign_templates')
        .select('*')
        .eq('academy_profile_id', academyId)
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
        .eq('academy_profile_id', academyId)
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
    return true;
  });

  const handleSaveTemplate = async () => {
    if (!templateName.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast({ title: 'Missing fields', description: 'Please fill in template name, subject, and body.', variant: 'destructive' });
      return;
    }

    try {
      if (editingTemplateId) {
        await supabase
          .from('email_campaign_templates')
          .update({ name: templateName.trim(), subject: subject.trim(), body_html: bodyHtml })
          .eq('id', editingTemplateId);
        toast({ title: 'Template updated' });
      } else {
        await supabase
          .from('email_campaign_templates')
          .insert({
            academy_profile_id: academyId,
            name: templateName.trim(),
            subject: subject.trim(),
            body_html: bodyHtml,
          } as any);
        toast({ title: 'Template saved' });
      }
      setEditingTemplateId(null);
      setTemplateName('');
      fetchTemplates();
    } catch (err) {
      logger.error('Error saving template', err as Error);
      toast({ title: 'Error', description: 'Could not save template.', variant: 'destructive' });
    }
  };

  const handleLoadTemplate = (template: CampaignTemplate) => {
    setSubject(template.subject);
    setBodyHtml(template.body_html);
    setTemplateName(template.name);
    setEditingTemplateId(template.id);
    setActiveView('compose');
    toast({ title: 'Template loaded', description: template.name });
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await supabase.from('email_campaign_templates').delete().eq('id', id);
      toast({ title: 'Template deleted' });
      fetchTemplates();
    } catch (err) {
      logger.error('Error deleting template', err as Error);
    }
  };

  const handleSendCampaign = async () => {
    setShowConfirmSend(false);
    setIsSending(true);

    try {
      // 1. Create campaign
      const filters = { trainer: filterTrainer, location: filterLocation, level: filterLevel, cyclus: filterCyclus };
      const { data: campaign, error: campErr } = await supabase
        .from('email_campaigns')
        .insert({
          academy_profile_id: academyId,
          subject: subject.trim(),
          body_html: bodyHtml,
          filters,
          status: 'draft',
          total_recipients: filteredRecipients.length,
        } as any)
        .select()
        .single();

      if (campErr || !campaign) throw campErr || new Error('Could not create campaign');

      // 2. Insert recipients
      const recipientRows = filteredRecipients.map((p) => ({
        campaign_id: campaign.id,
        recipient_email: p.email,
        recipient_name: p.full_name,
        status: 'pending',
      }));

      const { error: recErr } = await supabase
        .from('email_campaign_recipients')
        .insert(recipientRows as any);

      if (recErr) throw recErr;

      // 3. Invoke edge function
      const { error: fnErr } = await supabase.functions.invoke('send-campaign-emails', {
        body: { campaignId: campaign.id },
      });

      if (fnErr) throw fnErr;

      toast({
        title: 'Campaign sent!',
        description: `Emails are being sent to ${filteredRecipients.length} recipients.`,
      });

      // Reset
      setSubject('');
      setBodyHtml('');
      setTemplateName('');
      setEditingTemplateId(null);
      fetchCampaigns();
    } catch (err: any) {
      logger.error('Error sending campaign', err);
      toast({ title: 'Error', description: err.message || 'Could not send campaign.', variant: 'destructive' });
    } finally {
      setIsSending(false);
    }
  };

  // Simple text → HTML conversion for the editor
  const handleEditorInput = (e: React.FormEvent<HTMLDivElement>) => {
    setBodyHtml(e.currentTarget.innerHTML);
  };

  const insertBold = () => {
    document.execCommand('bold', false);
  };

  const insertVariable = (variable: string) => {
    document.execCommand('insertText', false, `{{${variable}}}`);
  };

  const getPreviewHtml = () => {
    return bodyHtml.replace(/\{\{name\}\}/gi, 'Jan de Vries');
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sent': return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">Sent</Badge>;
      case 'sending': return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">Sending...</Badge>;
      case 'draft': return <Badge variant="secondary">Draft</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      <Tabs value={activeView} onValueChange={setActiveView}>
        <TabsList>
          <TabsTrigger value="compose" className="gap-1.5">
            <Send className="h-3.5 w-3.5" /> Compose
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" /> Templates
            {templates.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-xs">{templates.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-1.5">
            <History className="h-3.5 w-3.5" /> History
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
                  <Users className="h-4 w-4" /> Recipients
                </CardTitle>
                <CardDescription>
                  Filter players to select who receives the email.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Trainer</Label>
                  <Select value={filterTrainer} onValueChange={setFilterTrainer}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All trainers</SelectItem>
                      {trainers.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Location</Label>
                  <Select value={filterLocation} onValueChange={setFilterLocation}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All locations</SelectItem>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.name}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Level</Label>
                  <Select value={filterLevel} onValueChange={setFilterLevel}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All levels</SelectItem>
                      <SelectItem value="beginner">Beginner (1-3)</SelectItem>
                      <SelectItem value="intermediate">Intermediate (4-6)</SelectItem>
                      <SelectItem value="advanced">Advanced (7-9)</SelectItem>
                      <SelectItem value="pro">Pro (9+)</SelectItem>
                      <SelectItem value="unrated">Unrated</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Active cyclus</Label>
                  <Select value={filterCyclus} onValueChange={setFilterCyclus}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <div className="flex items-center justify-between py-2">
                  <span className="text-sm font-medium">Selected recipients</span>
                  <Badge variant="secondary" className="text-sm">
                    {filteredRecipients.length}
                  </Badge>
                </div>

                {filteredRecipients.length > 0 && (
                  <div className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
                    {filteredRecipients.slice(0, 50).map((p) => (
                      <div key={p.id} className="text-xs flex justify-between items-center py-0.5">
                        <span className="truncate flex-1">{p.full_name}</span>
                        <span className="text-muted-foreground truncate ml-2 max-w-[120px]">{p.email}</span>
                      </div>
                    ))}
                    {filteredRecipients.length > 50 && (
                      <p className="text-xs text-muted-foreground text-center pt-1">
                        +{filteredRecipients.length - 50} more
                      </p>
                    )}
                  </div>
                )}

                {filteredRecipients.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No players match the current filters, or they have no email address.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Email composer panel */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Compose Email</CardTitle>
                <CardDescription>
                  Use <code className="text-xs bg-muted px-1 py-0.5 rounded">{'{{name}}'}</code> to insert the player's name.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-subject">Subject</Label>
                  <Input
                    id="campaign-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g. New training season starts soon!"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>Body</Label>
                  <div className="border rounded-md">
                    <div className="flex items-center gap-1 p-2 border-b bg-muted/30">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        onClick={insertBold}
                        title="Bold"
                      >
                        <Bold className="h-3.5 w-3.5" />
                      </Button>
                      <Separator orientation="vertical" className="h-5" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => insertVariable('name')}
                      >
                        {'{{name}}'}
                      </Button>
                    </div>
                    <div
                      contentEditable
                      className="min-h-[200px] p-3 text-sm focus:outline-none prose prose-sm max-w-none [&_b]:font-bold [&_strong]:font-bold"
                      onInput={handleEditorInput}
                      dangerouslySetInnerHTML={{ __html: bodyHtml }}
                      suppressContentEditableWarning
                    />
                  </div>
                </div>

                {/* Save template row */}
                <div className="flex items-center gap-2">
                  <Input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Template name (optional)"
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
                    {editingTemplateId ? 'Update template' : 'Save as template'}
                  </Button>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowPreview(true)}
                    disabled={!bodyHtml.trim()}
                  >
                    <Eye className="mr-1.5 h-4 w-4" /> Preview
                  </Button>

                  <Button
                    onClick={() => setShowConfirmSend(true)}
                    disabled={isSending || !subject.trim() || !bodyHtml.trim() || filteredRecipients.length === 0}
                  >
                    {isSending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    Send to {filteredRecipients.length} recipient{filteredRecipients.length !== 1 ? 's' : ''}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Templates View */}
        <TabsContent value="templates" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Saved Templates</CardTitle>
              <CardDescription>Reuse email templates for recurring campaigns.</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingTemplates ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : templates.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No templates saved yet. Compose an email and save it as a template.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-[100px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates.map((tmpl) => (
                      <TableRow key={tmpl.id} className="cursor-pointer" onClick={() => handleLoadTemplate(tmpl)}>
                        <TableCell className="font-medium">{tmpl.name}</TableCell>
                        <TableCell className="text-muted-foreground">{tmpl.subject}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {format(new Date(tmpl.created_at), 'dd MMM yyyy')}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={(e) => { e.stopPropagation(); handleLoadTemplate(tmpl); }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
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
              <CardTitle className="text-base">Campaign History</CardTitle>
              <CardDescription>Overview of sent email campaigns.</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingCampaigns ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : campaigns.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No campaigns sent yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Subject</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Recipients</TableHead>
                      <TableHead>Sent / Failed</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaigns.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium max-w-[200px] truncate">{c.subject}</TableCell>
                        <TableCell>{getStatusBadge(c.status)}</TableCell>
                        <TableCell>{c.total_recipients}</TableCell>
                        <TableCell>
                          <span className="text-green-600">{c.sent_count}</span>
                          {c.failed_count > 0 && (
                            <span className="text-destructive ml-1">/ {c.failed_count} failed</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {c.sent_at ? format(new Date(c.sent_at), 'dd MMM yyyy HH:mm') : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Confirm Send Dialog */}
      <AlertDialog open={showConfirmSend} onOpenChange={setShowConfirmSend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send campaign?</AlertDialogTitle>
            <AlertDialogDescription>
              This will send an email to <strong>{filteredRecipients.length} recipient{filteredRecipients.length !== 1 ? 's' : ''}</strong> with subject "<strong>{subject}</strong>". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSendCampaign}>
              <Send className="mr-2 h-4 w-4" /> Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview Dialog */}
      <AlertDialog open={showPreview} onOpenChange={setShowPreview}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Email Preview</AlertDialogTitle>
            <AlertDialogDescription>
              Preview with sample data: name = "Jan de Vries"
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="border rounded-md p-4 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground">Subject</p>
              <p className="font-medium">{subject.replace(/\{\{name\}\}/gi, 'Jan de Vries')}</p>
            </div>
            <Separator />
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: getPreviewHtml() }}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
