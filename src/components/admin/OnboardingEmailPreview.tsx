import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";
import { type OnboardingEmailTemplate } from "@/lib/onboardingEmails";

interface OnboardingEmailPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: OnboardingEmailTemplate | null;
  onSendTest: (email: string) => void;
  isSendingTest?: boolean;
}

// Sample data for preview
const SAMPLE_DATA = {
  user_name: "John Doe",
  user_email: "john.doe@example.com",
  user_type: "Trainer",
  signup_date: new Date().toLocaleDateString(),
  plan_name: "Pro Plan",
};

function replaceVariables(text: string): string {
  let result = text;
  Object.entries(SAMPLE_DATA).forEach(([key, value]) => {
    result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
  });
  return result;
}

export function OnboardingEmailPreview({
  open,
  onOpenChange,
  template,
  onSendTest,
  isSendingTest,
}: OnboardingEmailPreviewProps) {
  const { t } = useTranslation("admin");
  const [testEmail, setTestEmail] = useState("");

  if (!template) return null;

  const previewSubject = replaceVariables(template.subject);
  const previewBody = replaceVariables(template.body_html);

  const handleSendTest = () => {
    if (testEmail.trim()) {
      onSendTest(testEmail.trim());
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("onboardingEmails.previewTitle")}</DialogTitle>
          <DialogDescription>
            {t("onboardingEmails.previewDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Template Info */}
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{template.name}</Badge>
            <Badge variant="secondary">
              {t(`onboardingEmails.userTypes.${template.user_type}`)}
            </Badge>
            <Badge variant="secondary">
              {t(`onboardingEmails.triggerTypes.${template.trigger_type}`)}
            </Badge>
            <Badge variant="secondary">
              {t("onboardingEmails.delayDaysLabel", { days: template.delay_days })}
            </Badge>
          </div>

          <Separator />

          {/* Email Preview */}
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">
              {t("onboardingEmails.subjectLabel")}
            </div>
            <div className="font-medium text-lg">{previewSubject}</div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">
              {t("onboardingEmails.bodyLabel")}
            </div>
            <div
              className="border rounded-lg p-4 bg-background prose prose-sm max-w-none dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: previewBody }}
            />
          </div>

          <Separator />

          {/* Send Test Email */}
          <div className="space-y-2">
            <Label htmlFor="testEmail">{t("onboardingEmails.sendTestTo")}</Label>
            <div className="flex gap-2">
              <Input
                id="testEmail"
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder={t("onboardingEmails.testEmailPlaceholder")}
              />
              <Button
                onClick={handleSendTest}
                disabled={!testEmail.trim() || isSendingTest}
              >
                {isSendingTest
                  ? t("onboardingEmails.sending")
                  : t("onboardingEmails.sendTest")}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("onboardingEmails.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
