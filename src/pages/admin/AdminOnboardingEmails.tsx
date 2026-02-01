import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, Eye, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OnboardingEmailDialog } from "@/components/admin/OnboardingEmailDialog";
import { OnboardingEmailPreview } from "@/components/admin/OnboardingEmailPreview";
import {
  useOnboardingTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useToggleTemplateActive,
  useEmailQueue,
  useEmailLogs,
  useSendTestEmail,
  useCancelQueuedEmail,
} from "@/hooks/useOnboardingEmails";
import {
  type OnboardingEmailTemplate,
  type UserType,
  type TriggerType,
} from "@/lib/onboardingEmails";
import { format } from "date-fns";

export default function AdminOnboardingEmails() {
  const { t } = useTranslation("admin");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<OnboardingEmailTemplate | null>(null);

  const { data: templates, isLoading: templatesLoading } = useOnboardingTemplates();
  const { data: queue, isLoading: queueLoading } = useEmailQueue();
  const { data: logs, isLoading: logsLoading } = useEmailLogs();

  const createMutation = useCreateTemplate();
  const updateMutation = useUpdateTemplate();
  const deleteMutation = useDeleteTemplate();
  const toggleMutation = useToggleTemplateActive();
  const sendTestMutation = useSendTestEmail();
  const cancelQueueMutation = useCancelQueuedEmail();

  const handleCreate = () => {
    setSelectedTemplate(null);
    setDialogOpen(true);
  };

  const handleEdit = (template: OnboardingEmailTemplate) => {
    setSelectedTemplate(template);
    setDialogOpen(true);
  };

  const handlePreview = (template: OnboardingEmailTemplate) => {
    setSelectedTemplate(template);
    setPreviewOpen(true);
  };

  const handleDelete = (template: OnboardingEmailTemplate) => {
    setSelectedTemplate(template);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (selectedTemplate) {
      deleteMutation.mutate(selectedTemplate.id, {
        onSuccess: () => setDeleteDialogOpen(false),
      });
    }
  };

  const handleSave = (data: {
    name: string;
    user_type: UserType;
    trigger_type: TriggerType;
    delay_days: number;
    subject: string;
    body_html: string;
    is_active: boolean;
  }) => {
    if (selectedTemplate) {
      updateMutation.mutate(
        { id: selectedTemplate.id, ...data },
        { onSuccess: () => setDialogOpen(false) }
      );
    } else {
      createMutation.mutate(data, { onSuccess: () => setDialogOpen(false) });
    }
  };

  const handleToggleActive = (template: OnboardingEmailTemplate) => {
    toggleMutation.mutate({ id: template.id, is_active: !template.is_active });
  };

  const handleSendTest = (email: string) => {
    if (selectedTemplate) {
      sendTestMutation.mutate({
        templateId: selectedTemplate.id,
        testEmail: email,
      });
    }
  };

  const getUserTypeBadge = (userType: string) => {
    const colors: Record<string, string> = {
      player: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      trainer: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      club: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      academy: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
    };
    return (
      <Badge className={colors[userType] || ""} variant="secondary">
        {t(`onboardingEmails.userTypes.${userType}`)}
      </Badge>
    );
  };

  const getTriggerBadge = (triggerType: string) => {
    return (
      <Badge variant="outline">
        {t(`onboardingEmails.triggerTypes.${triggerType}`)}
      </Badge>
    );
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      pending: "secondary",
      sent: "default",
      failed: "destructive",
      cancelled: "outline",
    };
    return (
      <Badge variant={variants[status] || "secondary"}>
        {t(`onboardingEmails.status.${status}`)}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("onboardingEmails.title")}</h1>
          <p className="text-muted-foreground">{t("onboardingEmails.description")}</p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="h-4 w-4 mr-2" />
          {t("onboardingEmails.addTemplate")}
        </Button>
      </div>

      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">
            <Mail className="h-4 w-4 mr-2" />
            {t("onboardingEmails.tabs.templates")}
          </TabsTrigger>
          <TabsTrigger value="queue">
            {t("onboardingEmails.tabs.queue")}
          </TabsTrigger>
          <TabsTrigger value="logs">
            {t("onboardingEmails.tabs.logs")}
          </TabsTrigger>
        </TabsList>

        {/* Templates Tab */}
        <TabsContent value="templates">
          <Card>
            <CardHeader>
              <CardTitle>{t("onboardingEmails.templatesTitle")}</CardTitle>
              <CardDescription>{t("onboardingEmails.templatesDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {templatesLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : templates?.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {t("onboardingEmails.noTemplates")}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("onboardingEmails.columns.name")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.userType")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.trigger")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.delay")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.active")}</TableHead>
                      <TableHead className="text-right">{t("onboardingEmails.columns.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates?.map((template) => (
                      <TableRow key={template.id}>
                        <TableCell className="font-medium">{template.name}</TableCell>
                        <TableCell>{getUserTypeBadge(template.user_type)}</TableCell>
                        <TableCell>{getTriggerBadge(template.trigger_type)}</TableCell>
                        <TableCell>
                          {template.delay_days === 0
                            ? t("onboardingEmails.immediately")
                            : t("onboardingEmails.daysAfter", { days: template.delay_days })}
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={template.is_active}
                            onCheckedChange={() => handleToggleActive(template)}
                            disabled={toggleMutation.isPending}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handlePreview(template)}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(template)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDelete(template)}
                            >
                              <Trash2 className="h-4 w-4" />
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

        {/* Queue Tab */}
        <TabsContent value="queue">
          <Card>
            <CardHeader>
              <CardTitle>{t("onboardingEmails.queueTitle")}</CardTitle>
              <CardDescription>{t("onboardingEmails.queueDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {queueLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : queue?.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {t("onboardingEmails.noQueuedEmails")}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("onboardingEmails.columns.recipient")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.template")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.scheduledFor")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.status")}</TableHead>
                      <TableHead className="text-right">{t("onboardingEmails.columns.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue?.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div>
                            <div className="font-medium">{item.user_name}</div>
                            <div className="text-sm text-muted-foreground">{item.email}</div>
                          </div>
                        </TableCell>
                        <TableCell>{item.template?.name || "-"}</TableCell>
                        <TableCell>
                          {format(new Date(item.scheduled_for), "PPp")}
                        </TableCell>
                        <TableCell>{getStatusBadge(item.status)}</TableCell>
                        <TableCell className="text-right">
                          {item.status === "pending" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => cancelQueueMutation.mutate(item.id)}
                              disabled={cancelQueueMutation.isPending}
                            >
                              {t("onboardingEmails.cancel")}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs">
          <Card>
            <CardHeader>
              <CardTitle>{t("onboardingEmails.logsTitle")}</CardTitle>
              <CardDescription>{t("onboardingEmails.logsDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {logsLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : logs?.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {t("onboardingEmails.noLogs")}
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("onboardingEmails.columns.email")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.subject")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.sentAt")}</TableHead>
                      <TableHead>{t("onboardingEmails.columns.status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs?.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>{log.email}</TableCell>
                        <TableCell>{log.subject}</TableCell>
                        <TableCell>
                          {format(new Date(log.sent_at), "PPp")}
                        </TableCell>
                        <TableCell>{getStatusBadge(log.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <OnboardingEmailDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        template={selectedTemplate}
        onSave={handleSave}
        isSaving={createMutation.isPending || updateMutation.isPending}
      />

      <OnboardingEmailPreview
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        template={selectedTemplate}
        onSendTest={handleSendTest}
        isSendingTest={sendTestMutation.isPending}
      />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("onboardingEmails.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("onboardingEmails.deleteConfirm", { name: selectedTemplate?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("onboardingEmails.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("onboardingEmails.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
