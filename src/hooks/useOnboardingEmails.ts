import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchOnboardingTemplates,
  createOnboardingTemplate,
  updateOnboardingTemplate,
  deleteOnboardingTemplate,
  toggleTemplateActive,
  fetchEmailQueue,
  fetchEmailLogs,
  cancelQueuedEmail,
  sendTestEmail,
  type OnboardingEmailTemplate,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type EmailStatus,
} from "@/lib/onboardingEmails";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

const TEMPLATES_KEY = ["onboarding-email-templates"];
const QUEUE_KEY = ["onboarding-email-queue"];
const LOGS_KEY = ["onboarding-email-logs"];

export function useOnboardingTemplates() {
  return useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: fetchOnboardingTemplates,
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("admin");

  return useMutation({
    mutationFn: (input: CreateTemplateInput) => createOnboardingTemplate(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
      toast.success(t("onboardingEmails.templateCreated"));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useUpdateTemplate() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("admin");

  return useMutation({
    mutationFn: (input: UpdateTemplateInput) => updateOnboardingTemplate(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
      toast.success(t("onboardingEmails.templateUpdated"));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("admin");

  return useMutation({
    mutationFn: (id: string) => deleteOnboardingTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
      toast.success(t("onboardingEmails.templateDeleted"));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useToggleTemplateActive() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("admin");

  return useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      toggleTemplateActive(id, is_active),
    onSuccess: (data: OnboardingEmailTemplate) => {
      queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY });
      toast.success(
        data.is_active
          ? t("onboardingEmails.templateEnabled")
          : t("onboardingEmails.templateDisabled")
      );
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useEmailQueue(status?: EmailStatus) {
  return useQuery({
    queryKey: [...QUEUE_KEY, status],
    queryFn: () => fetchEmailQueue(status),
  });
}

export function useEmailLogs(limit = 100) {
  return useQuery({
    queryKey: [...LOGS_KEY, limit],
    queryFn: () => fetchEmailLogs(limit),
  });
}

export function useCancelQueuedEmail() {
  const queryClient = useQueryClient();
  const { t } = useTranslation("admin");

  return useMutation({
    mutationFn: (id: string) => cancelQueuedEmail(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      toast.success(t("onboardingEmails.emailCancelled"));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}

export function useSendTestEmail() {
  const { t } = useTranslation("admin");

  return useMutation({
    mutationFn: ({ templateId, testEmail }: { templateId: string; testEmail: string }) =>
      sendTestEmail(templateId, testEmail),
    onSuccess: (result) => {
      if (result.success) {
        toast.success(t("onboardingEmails.testEmailSent"));
      } else {
        toast.error(result.error || t("onboardingEmails.testEmailFailed"));
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
}
