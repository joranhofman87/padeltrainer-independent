import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, Eye, Mail, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectFilter } from "@/components/ui/select-filter";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { DataTable, type ColumnDef } from "@/components/ui/data-table-generic";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  type OnboardingEmailQueue,
  type OnboardingEmailLog,
  type UserType,
  type TriggerType,
} from "@/lib/onboardingEmails";
import { format } from "date-fns";

export default function AdminOnboardingEmails() {
  const { t } = useTranslation("admin");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userTypeFilter, setUserTypeFilter] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [selectedTemplate, setSelectedTemplate] = useState<OnboardingEmailTemplate | null>(null);

  const { data: templates, isLoading: templatesLoading } = useOnboardingTemplates();
  const { data: queue, isLoading: queueLoading } = useEmailQueue();
  const { data: logs, isLoading: logsLoading } = useEmailLogs();

  const filteredTemplates = useMemo(() => {
    if (!templates) return [];
    return templates.filter((template) => {
      const matchesUserType = userTypeFilter === "all" || template.user_type === userTypeFilter;
      const matchesActive =
        activeFilter === "all" ||
        (activeFilter === "active" && template.is_active) ||
        (activeFilter === "inactive" && !template.is_active);
      return matchesUserType && matchesActive;
    });
  }, [templates, userTypeFilter, activeFilter]);

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

  const handleDuplicate = (template: OnboardingEmailTemplate) => {
    const duplicatedData = {
      name: `${template.name} (${t("onboardingEmails.copy")})`,
      user_type: template.user_type,
      trigger_type: template.trigger_type,
      delay_days: template.delay_days,
      subject: template.subject,
      body_html: template.body_html,
      is_active: false, // Start as inactive
    };
    createMutation.mutate(duplicatedData);
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

  const templateColumns: ColumnDef<OnboardingEmailTemplate>[] = [
    {
      key: "name",
      header: t("onboardingEmails.columns.name"),
      className: "font-medium max-w-[240px]",
      cellTitle: (tpl) => tpl.name,
      renderCell: (tpl) => <span className="block truncate">{tpl.name}</span>,
    },
    {
      key: "userType",
      header: t("onboardingEmails.columns.userType"),
      renderCell: (tpl) => getUserTypeBadge(tpl.user_type),
    },
    {
      key: "trigger",
      header: t("onboardingEmails.columns.trigger"),
      renderCell: (tpl) => getTriggerBadge(tpl.trigger_type),
    },
    {
      key: "delay",
      header: t("onboardingEmails.columns.delay"),
      className: "whitespace-nowrap",
      renderCell: (tpl) =>
        tpl.delay_days === 0
          ? t("onboardingEmails.immediately")
          : t("onboardingEmails.daysAfter", { days: tpl.delay_days }),
    },
    {
      key: "active",
      header: t("onboardingEmails.columns.active"),
      renderCell: (tpl) => (
        <Switch
          checked={tpl.is_active}
          onCheckedChange={() => handleToggleActive(tpl)}
          disabled={toggleMutation.isPending}
        />
      ),
    },
  ];

  const renderTemplateActions = (tpl: OnboardingEmailTemplate) => (
    <>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handlePreview(tpl)} title={t("onboardingEmails.preview")}>
        <Eye className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Copy" onClick={() => handleDuplicate(tpl)} disabled={createMutation.isPending} title={t("onboardingEmails.duplicate")}>
        <Copy className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Edit" onClick={() => handleEdit(tpl)} title={t("onboardingEmails.edit")}>
        <Pencil className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Delete" onClick={() => handleDelete(tpl)} title={t("onboardingEmails.delete")}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </>
  );

  // Two-line recipient (name + email) split into two columns — a stacked cell would clip at 40px.
  const queueColumns: ColumnDef<OnboardingEmailQueue>[] = [
    {
      key: "recipient",
      header: t("onboardingEmails.columns.recipient"),
      className: "font-medium max-w-[200px]",
      cellTitle: (item) => item.user_name,
      renderCell: (item) => <span className="block truncate">{item.user_name}</span>,
    },
    {
      key: "email",
      header: t("onboardingEmails.columns.email"),
      className: "text-muted-foreground max-w-[220px]",
      cellTitle: (item) => item.email,
      renderCell: (item) => <span className="block truncate">{item.email}</span>,
    },
    {
      key: "template",
      header: t("onboardingEmails.columns.template"),
      renderCell: (item) => item.template?.name || "-",
    },
    {
      key: "scheduledFor",
      header: t("onboardingEmails.columns.scheduledFor"),
      className: "whitespace-nowrap",
      renderCell: (item) => format(new Date(item.scheduled_for), "PPp"),
    },
    {
      key: "status",
      header: t("onboardingEmails.columns.status"),
      renderCell: (item) => getStatusBadge(item.status),
    },
  ];

  const renderQueueActions = (item: OnboardingEmailQueue) =>
    item.status === "pending" ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => cancelQueueMutation.mutate(item.id)}
        disabled={cancelQueueMutation.isPending}
      >
        {t("onboardingEmails.cancel")}
      </Button>
    ) : null;

  const logColumns: ColumnDef<OnboardingEmailLog>[] = [
    {
      key: "email",
      header: t("onboardingEmails.columns.email"),
      className: "max-w-[220px]",
      cellTitle: (log) => log.email,
      renderCell: (log) => <span className="block truncate">{log.email}</span>,
    },
    {
      key: "subject",
      header: t("onboardingEmails.columns.subject"),
      className: "max-w-[280px]",
      cellTitle: (log) => log.subject,
      renderCell: (log) => <span className="block truncate">{log.subject}</span>,
    },
    {
      key: "sentAt",
      header: t("onboardingEmails.columns.sentAt"),
      className: "whitespace-nowrap",
      renderCell: (log) => format(new Date(log.sent_at), "PPp"),
    },
    {
      key: "status",
      header: t("onboardingEmails.columns.status"),
      renderCell: (log) => getStatusBadge(log.status),
    },
  ];

  const loadingSkeleton = (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );

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
        <TabsContent value="templates" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t("onboardingEmails.templatesTitle")}</h2>
              <p className="text-sm text-muted-foreground">{t("onboardingEmails.templatesDescription")}</p>
            </div>
            <div className="flex gap-2">
              <SelectFilter
                value={userTypeFilter}
                onValueChange={setUserTypeFilter}
                allLabel={t("onboardingEmails.allUserTypes")}
                options={[
                  { value: "player", label: t("onboardingEmails.userTypes.player") },
                  { value: "trainer", label: t("onboardingEmails.userTypes.trainer") },
                  { value: "club", label: t("onboardingEmails.userTypes.club") },
                  { value: "academy", label: t("onboardingEmails.userTypes.academy") },
                ]}
                placeholder={t("onboardingEmails.filterUserType")}
                triggerClassName="w-[140px]"
              />
              <SelectFilter
                value={activeFilter}
                onValueChange={setActiveFilter}
                allLabel={t("onboardingEmails.allStatuses")}
                options={[
                  { value: "active", label: t("onboardingEmails.activeOnly") },
                  { value: "inactive", label: t("onboardingEmails.inactiveOnly") },
                ]}
                placeholder={t("onboardingEmails.filterStatus")}
                triggerClassName="w-[120px]"
              />
            </div>
          </div>
          {templatesLoading ? (
            loadingSkeleton
          ) : (
            <DataTable<OnboardingEmailTemplate>
              columns={templateColumns}
              rows={filteredTemplates}
              renderActions={renderTemplateActions}
              actionsHeader={t("onboardingEmails.columns.actions")}
              compact
              desktopOnly={false}
              empty={t("onboardingEmails.noTemplates")}
            />
          )}
        </TabsContent>

        {/* Queue Tab */}
        <TabsContent value="queue" className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{t("onboardingEmails.queueTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("onboardingEmails.queueDescription")}</p>
          </div>
          {queueLoading ? (
            loadingSkeleton
          ) : (
            <DataTable<OnboardingEmailQueue>
              columns={queueColumns}
              rows={queue ?? []}
              renderActions={renderQueueActions}
              actionsHeader={t("onboardingEmails.columns.actions")}
              compact
              desktopOnly={false}
              empty={t("onboardingEmails.noQueuedEmails")}
            />
          )}
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs" className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{t("onboardingEmails.logsTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("onboardingEmails.logsDescription")}</p>
          </div>
          {logsLoading ? (
            loadingSkeleton
          ) : (
            <DataTable<OnboardingEmailLog>
              columns={logColumns}
              rows={logs ?? []}
              compact
              desktopOnly={false}
              empty={t("onboardingEmails.noLogs")}
            />
          )}
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

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("onboardingEmails.deleteTitle")}
        description={t("onboardingEmails.deleteConfirm", { name: selectedTemplate?.name })}
        confirmLabel={t("onboardingEmails.delete")}
        cancelLabel={t("onboardingEmails.cancel")}
        loading={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
