import { useState, useEffect } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  type OnboardingEmailTemplate,
  type UserType,
  type TriggerType,
  TEMPLATE_VARIABLES,
} from "@/lib/onboardingEmails";

interface OnboardingEmailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: OnboardingEmailTemplate | null;
  onSave: (data: {
    name: string;
    user_type: UserType;
    trigger_type: TriggerType;
    delay_days: number;
    subject: string;
    body_html: string;
    is_active: boolean;
  }) => void;
  isSaving?: boolean;
}

export function OnboardingEmailDialog({
  open,
  onOpenChange,
  template,
  onSave,
  isSaving,
}: OnboardingEmailDialogProps) {
  const { t } = useTranslation("admin");
  const isEditing = !!template;

  const [name, setName] = useState("");
  const [userType, setUserType] = useState<UserType>("player");
  const [triggerType, setTriggerType] = useState<TriggerType>("signup");
  const [delayDays, setDelayDays] = useState(0);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (template) {
      setName(template.name);
      setUserType(template.user_type);
      setTriggerType(template.trigger_type);
      setDelayDays(template.delay_days);
      setSubject(template.subject);
      setBodyHtml(template.body_html);
      setIsActive(template.is_active);
    } else {
      setName("");
      setUserType("player");
      setTriggerType("signup");
      setDelayDays(0);
      setSubject("");
      setBodyHtml("");
      setIsActive(true);
    }
  }, [template, open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim() || !subject.trim() || !bodyHtml.trim()) {
      toast.error(t("onboardingEmails.validationError"));
      return;
    }

    onSave({
      name: name.trim(),
      user_type: userType,
      trigger_type: triggerType,
      delay_days: delayDays,
      subject: subject.trim(),
      body_html: bodyHtml.trim(),
      is_active: isActive,
    });
  };

  const copyVariable = (variable: string) => {
    navigator.clipboard.writeText(variable);
    toast.success(t("onboardingEmails.variableCopied"));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t("onboardingEmails.editTitle")
              : t("onboardingEmails.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("onboardingEmails.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Template Name */}
          <div className="space-y-2">
            <Label htmlFor="name">{t("onboardingEmails.templateName")}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("onboardingEmails.templateNamePlaceholder")}
              required
            />
          </div>

          {/* User Type & Trigger Type */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("onboardingEmails.userType")}</Label>
              <Select value={userType} onValueChange={(v) => setUserType(v as UserType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="player">{t("onboardingEmails.userTypes.player")}</SelectItem>
                  <SelectItem value="trainer">{t("onboardingEmails.userTypes.trainer")}</SelectItem>
                  <SelectItem value="club">{t("onboardingEmails.userTypes.club")}</SelectItem>
                  <SelectItem value="academy">{t("onboardingEmails.userTypes.academy")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t("onboardingEmails.triggerType")}</Label>
              <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="signup">{t("onboardingEmails.triggerTypes.signup")}</SelectItem>
                  <SelectItem value="paid_plan">{t("onboardingEmails.triggerTypes.paid_plan")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Delay Days */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="delayDays">{t("onboardingEmails.delayDays")}</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  {t("onboardingEmails.delayDaysHelp")}
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              id="delayDays"
              type="number"
              min={0}
              max={365}
              value={delayDays}
              onChange={(e) => setDelayDays(parseInt(e.target.value) || 0)}
            />
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label htmlFor="subject">{t("onboardingEmails.subject")}</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("onboardingEmails.subjectPlaceholder")}
              required
            />
          </div>

          {/* Template Variables */}
          <div className="space-y-2">
            <Label>{t("onboardingEmails.availableVariables")}</Label>
            <div className="flex flex-wrap gap-2">
              {TEMPLATE_VARIABLES.map((variable) => (
                <Tooltip key={variable.key}>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="cursor-pointer hover:bg-secondary/80"
                      onClick={() => copyVariable(variable.key)}
                    >
                      {variable.key}
                      <Copy className="h-3 w-3 ml-1" />
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{variable.description}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>

          {/* Body HTML */}
          <div className="space-y-2">
            <Label htmlFor="bodyHtml">{t("onboardingEmails.bodyHtml")}</Label>
            <Textarea
              id="bodyHtml"
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              placeholder={t("onboardingEmails.bodyHtmlPlaceholder")}
              rows={10}
              className="font-mono text-sm"
              required
            />
          </div>

          {/* Active Toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t("onboardingEmails.active")}</Label>
              <p className="text-sm text-muted-foreground">
                {t("onboardingEmails.activeDescription")}
              </p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("onboardingEmails.cancel")}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? t("onboardingEmails.saving")
                : isEditing
                ? t("onboardingEmails.save")
                : t("onboardingEmails.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
